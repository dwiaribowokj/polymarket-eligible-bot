import { ethers } from 'ethers';
import { ctfMergePositionsCall, ctfRedeemPositionsCall } from '@polymarket/client';
import { CONTRACTS } from '../restart/client.js';

const HASH = /^0x[\da-f]{64}$/i, ADDRESS = /^0x[\da-f]{40}$/i;
const HEX = /^0x(?:[\da-f]{2})*$/i, ZERO = ethers.constants.AddressZero;
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const same = (a, b) => ADDRESS.test(a || '') && lower(a) === lower(b);
const safe = new ethers.utils.Interface([
    'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
    'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
    'event ExecutionFailure(bytes32 txHash,uint256 payment)',
]);
const erc20 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
]);
const safeTypes = { SafeTx: [ ['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256'] ].map(([name, type]) => ({ name, type })) };
const uint = value => {
    if (!/^\d+$/.test(value?.toString() || '')) throw new Error('invalid_uint');
    return BigInt(value.toString());
};
const units = value => {
    const scaled = Math.round(value * 1e6);
    if (!Number.isFinite(value) || !Number.isSafeInteger(scaled) || Math.abs(value * 1e6 - scaled) > .00001)
        throw new Error('invalid_amount');
    return BigInt(scaled);
};
const amount = value => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('invalid_amount');
    return Number(value) / 1e6;
};

// Bind a terminal receipt to the exact persisted, signed Polygon transaction
// and its Safe nonce. This function only reads; it cannot sign or broadcast.
export function persistedActionIdentity({ position, wallet, action }) {
    try {
        if (!ADDRESS.test(wallet || '') || !HASH.test(position?.market?.conditionId || '')
            || position.market.negRisk === true || !['merge', 'redeem'].includes(action?.kind)
            || !HASH.test(action.hash || '') || !HEX.test(action.raw || '') || action.raw === '0x'
            || !/^\d+$/.test(action.safeNonce || '') || !Number.isFinite(action.polUsd) || action.polUsd <= 0
            || !Number.isFinite(action.createdAt)) return null;
        const tx = ethers.utils.parseTransaction(action.raw);
        if (lower(ethers.utils.keccak256(action.raw)) !== lower(action.hash) || lower(tx.hash) !== lower(action.hash)
            || tx.chainId !== 137 || !same(tx.to, wallet) || !ADDRESS.test(tx.from || '') || !tx.value.isZero()
            || tx.gasLimit.lte(0) || tx.gasLimit.gt(500000)) return null;
        const call = action.kind === 'merge'
            ? ctfMergePositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken,
                position.market.conditionId, units(action.amount))
            : ctfRedeemPositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken, position.market.conditionId);
        if (action.kind === 'merge' ? units(action.amount) <= 0n : action.amount !== 0) return null;
        const args = safe.decodeFunctionData('execTransaction', tx.data);
        if (lower(safe.encodeFunctionData('execTransaction', [...args])) !== lower(tx.data)
            || !same(args.to, call.to) || lower(args.data) !== lower(call.data)
            || !args.value.isZero() || args.operation !== 0 || !args.safeTxGas.isZero()
            || !args.baseGas.isZero() || !args.gasPrice.isZero()
            || !same(args.gasToken, ZERO) || !same(args.refundReceiver, ZERO)
            || !/^0x[\da-f]{130}$/i.test(args.signatures)) return null;
        const message = Object.fromEntries(safeTypes.SafeTx.map(({ name }) =>
            [name, name === 'nonce' ? action.safeNonce : args[name]]));
        const safeHash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, safeTypes, message);
        const signature = ethers.utils.splitSignature(args.signatures);
        if (![31, 32].includes(signature.v)) return null;
        const signer = ethers.utils.recoverAddress(ethers.utils.hashMessage(ethers.utils.arrayify(safeHash)),
            { r: signature.r, s: signature.s, v: signature.v - 4 });
        if (!same(signer, tx.from)) return null;
        return { tx, safeHash: lower(safeHash), signer: lower(signer) };
    } catch { return null; }
}

function actionReceiptProof({ position, wallet, block, action, receipt }, allowPendingProtocol = false) {
    try {
        const identity = persistedActionIdentity({ position, wallet, action });
        if (!identity || !Number.isSafeInteger(block) || block < 0 || !receipt
            || lower(receipt.transactionHash) !== lower(action.hash) || !HASH.test(receipt.blockHash || '')
            || !same(receipt.to, wallet) || !same(receipt.from, identity.signer)
            || ![0, 1].includes(receipt.status) || !Number.isSafeInteger(receipt.blockNumber)
            || receipt.blockNumber < 0 || receipt.blockNumber > block
            || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2 || !Array.isArray(receipt.logs)
            || !Array.isArray(position.market.tokens) || position.market.tokens.length !== 2
            || new Set(position.market.tokens).size !== 2 || position.market.tokens.some(token => !/^\d+$/.test(token))
            || position.holdings?.length !== 2) return null;
        let cash = 0n, previous = -1;
        const holdings = [0n, 0n], executions = [];
        for (const log of receipt.logs) {
            if (!ADDRESS.test(log?.address || '') || !Number.isSafeInteger(log.logIndex) || log.logIndex <= previous
                || log.removed === true || !Array.isArray(log.topics) || log.topics.some(topic => !HASH.test(topic))
                || !HEX.test(log.data || '') || log.transactionHash !== undefined && lower(log.transactionHash) !== lower(action.hash)
                || log.blockHash !== undefined && lower(log.blockHash) !== lower(receipt.blockHash)
                || log.blockNumber !== undefined && log.blockNumber !== receipt.blockNumber) return null;
            previous = log.logIndex;
            const iface = same(log.address, wallet) ? safe : same(log.address, CONTRACTS.collateralToken) ? erc20
                : same(log.address, CONTRACTS.conditionalTokens) ? ctf : null;
            if (!iface) continue;
            const event = Object.values(iface.events).find(fragment => lower(iface.getEventTopic(fragment)) === lower(log.topics[0]));
            if (!event) continue;
            const parsed = iface.parseLog(log), args = parsed.args;
            if (iface === safe) {
                if (lower(args.txHash) !== identity.safeHash || !args.payment.isZero()) return null;
                executions.push(parsed.name);
            } else {
                const sign = BigInt(Number(same(args.to, wallet)) - Number(same(args.from, wallet)));
                if (!sign) continue;
                if (iface === erc20) cash += sign * uint(args.value);
                else {
                    const ids = parsed.name === 'TransferBatch' ? args.ids : [args.id];
                    const values = parsed.name === 'TransferBatch' ? args[4] : [args.value];
                    if (ids.length !== values.length || new Set(ids.map(String)).size !== ids.length) return null;
                    ids.forEach((id, index) => {
                        const held = position.market.tokens.indexOf(id.toString()), value = uint(values[index]);
                        if (held < 0 && value !== 0n) throw new Error('unowned_token');
                        if (held >= 0) holdings[held] += sign * value;
                    });
                }
            }
        }
        const success = receipt.status === 1 && executions.length === 1 && executions[0] === 'ExecutionSuccess';
        const failure = receipt.status === 0 && receipt.logs.length === 0
            || receipt.status === 1 && executions.length === 1 && executions[0] === 'ExecutionFailure';
        if (!success && !failure) return null;
        let awaitingProtocolRedemption = false;
        if (failure) {
            if (cash !== 0n || holdings.some(value => value !== 0n)) return null;
        } else {
            const current = position.holdings.map(units);
            if (current.some(value => value < 0n)) return null;
            let expectedCash, expectedHoldings;
            if (action.kind === 'merge') {
                expectedCash = units(action.amount); expectedHoldings = [-expectedCash, -expectedCash];
                if (current.some(value => value < expectedCash)) return null;
            } else {
                if (!Array.isArray(position.payout) || position.payout.length !== 2
                    || ![[0, 1], [1, 0]].some(row => row.every((value, i) => value === position.payout[i]))) return null;
                // A no-op redemption can finish an earlier exposed action
                // only after a receipt-proven protocol payout explains why
                // its inventory is now zero, in canonical transaction order.
                if (current.every(value => value === 0n) && !Object.values(position.receipts || {}).some(row =>
                    row.kind === 'protocol_auto_redeem' && row.source === 'receipt'
                    && lower(row.conditionId) === lower(position.market.conditionId) && HASH.test(row.hash || '')
                    && HASH.test(row.blockHash || '') && Number.isSafeInteger(row.blockNumber)
                    && (row.blockNumber < receipt.blockNumber || row.blockNumber === receipt.blockNumber
                        && Number.isSafeInteger(row.transactionIndex) && Number.isSafeInteger(receipt.transactionIndex)
                        && row.transactionIndex < receipt.transactionIndex))) return null;
                expectedCash = current.reduce((sum, value, i) => sum + value * BigInt(position.payout[i]), 0n);
                expectedHoldings = current.map(value => -value);
            }
            // This classification cannot authorize accounting. A canonical,
            // identity-bound Safe no-op can precede discovery of the protocol
            // payout that already consumed its inventory.
            awaitingProtocolRedemption = allowPendingProtocol && action.kind === 'redeem'
                && current.some(value => value > 0n) && cash === 0n && holdings.every(value => value === 0n);
            if (!awaitingProtocolRedemption
                && (cash !== expectedCash || holdings.some((value, i) => value !== expectedHoldings[i]))) return null;
        }
        const used = uint(receipt.gasUsed), price = uint(receipt.effectiveGasPrice);
        const cap = identity.tx.gasPrice ?? identity.tx.maxFeePerGas;
        if (used <= 0n || used > uint(identity.tx.gasLimit) || price <= 0n || !cap || price > uint(cap)
            || identity.tx.gasPrice && price !== uint(identity.tx.gasPrice)) return null;
        const gas = Number(ethers.utils.formatEther((used * price).toString())) * action.polUsd;
        if (!Number.isFinite(gas) || gas < 0) return null;
        return { hash: lower(action.hash), safeHash: identity.safeHash, signer: identity.signer,
            safeNonce: action.safeNonce, status: success ? 'confirmed' : 'failed', gas,
            cash: amount(cash), holdings: holdings.map(amount),
            blockNumber: receipt.blockNumber, blockHash: lower(receipt.blockHash),
            ...(awaitingProtocolRedemption ? { awaitingProtocolRedemption: true } : {}) };
    } catch { return null; }
}

export const verifyActionReceipt = input => actionReceiptProof(input);

// The broker must also prove the exact wallet/payout delta at one block and
// retain inventory and gas unaccounted until the actual protocol receipt arrives.
export function pendingProtocolActionReceipt(input) {
    const proof = actionReceiptProof(input, true);
    return proof?.status === 'confirmed' && proof.awaitingProtocolRedemption ? proof : null;
}
