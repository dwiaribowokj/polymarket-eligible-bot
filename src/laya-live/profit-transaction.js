import { ethers } from 'ethers';

const HASH = /^0x[\da-f]{64}$/i, ADDRESS = /^0x[\da-f]{40}$/i;
const HEX = /^0x(?:[\da-f]{2})*$/i, UINT = /^(?:0|[1-9]\d*)$/;
const ZERO = ethers.constants.AddressZero, MAX_UINT = (1n << 256n) - 1n;
const MAX_GAS = 500000n, MAX_FEE = 1000000000000n;
const HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const same = (a, b) => ADDRESS.test(a || '') && lower(a) === lower(b);
const address = value => ADDRESS.test(value || '') && !same(value, ZERO);
const uint = value => {
    const text = value?.toString();
    if (!UINT.test(text || '')) throw new Error('invalid_uint');
    const result = BigInt(text);
    if (result > MAX_UINT) throw new Error('invalid_uint');
    return result;
};
const units = value => {
    const result = Math.round(value * 1e6);
    if (!Number.isFinite(value) || !Number.isSafeInteger(result) || result <= 0
        || Math.abs(value * 1e6 - result) > .00001) throw new Error('invalid_profit_amount');
    return BigInt(result);
};
const safe = new ethers.utils.Interface([
    'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
    'event ExecutionSuccess(bytes32 txHash,uint256 payment)',
    'event ExecutionFailure(bytes32 txHash,uint256 payment)',
]);
const erc20 = new ethers.utils.Interface([
    'function transfer(address to,uint256 value) returns(bool)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const erc721 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const erc1155 = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
]);
const nativeToken = '0x0000000000000000000000000000000000001010';
const native = new ethers.utils.Interface([
    'event LogFeeTransfer(address indexed token,address indexed from,address indexed to,uint256 amount,uint256 input1,uint256 input2,uint256 output1,uint256 output2)',
]);
const safeTypes = { SafeTx: [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type })) };
const transferTopic = lower(erc20.getEventTopic('Transfer'));
const singleTopic = lower(erc1155.getEventTopic('TransferSingle'));
const batchTopic = lower(erc1155.getEventTopic('TransferBatch'));
const successTopic = lower(safe.getEventTopic('ExecutionSuccess'));
const failureTopic = lower(safe.getEventTopic('ExecutionFailure'));
const nativeFeeTopic = lower(native.getEventTopic('LogFeeTransfer'));

// Exact six-decimal ERC20 intent. Token selection and recipient ownership are
// checked by the caller; this helper has no provider or account configuration.
export function profitTransferCall({ token, recipient, amount } = {}) {
    if (!address(token) || !address(recipient) || same(token, recipient)) throw new Error('invalid_profit_transfer');
    return { to: token, data: erc20.encodeFunctionData('transfer', [recipient, units(amount).toString()]) };
}

// A persisted intent must describe the entire signed Safe call. Recomputing
// its hash also binds the otherwise absent Safe nonce to the owner signature.
// This function never signs, sends, changes state, or allocates a new nonce.
export function persistedProfitTransferIdentity({ wallet, transfer } = {}) {
    try {
        if (!address(wallet) || transfer?.kind !== 'profit_transfer' || !HASH.test(transfer.hash || '')
            || !HEX.test(transfer.raw || '') || transfer.raw === '0x'
            || typeof transfer.safeNonce !== 'string' || !UINT.test(transfer.safeNonce)
            || !Number.isFinite(transfer.polUsd) || transfer.polUsd <= 0
            || !Number.isSafeInteger(transfer.createdAt) || transfer.createdAt < 0
            || same(transfer.token, wallet) || same(transfer.recipient, wallet)) return null;
        uint(transfer.safeNonce);
        const call = profitTransferCall(transfer), expected = units(transfer.amount);
        const tx = ethers.utils.parseTransaction(transfer.raw);
        if (lower(ethers.utils.keccak256(transfer.raw)) !== lower(transfer.hash)
            || lower(tx.hash) !== lower(transfer.hash) || tx.chainId !== 137 || !same(tx.to, wallet)
            || !address(tx.from) || !tx.value.isZero() || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0
            || uint(tx.gasLimit) <= 0n || uint(tx.gasLimit) > MAX_GAS || ![null, 0, 2].includes(tx.type)) return null;
        const cap = tx.gasPrice ?? tx.maxFeePerGas;
        if (!cap || uint(cap) <= 0n || uint(cap) > MAX_FEE
            || tx.type === 2 && (!tx.maxPriorityFeePerGas || uint(tx.maxPriorityFeePerGas) <= 0n
                || uint(tx.maxPriorityFeePerGas) > uint(cap))) return null;
        const args = safe.decodeFunctionData('execTransaction', tx.data);
        if (lower(safe.encodeFunctionData('execTransaction', [...args])) !== lower(tx.data)
            || !same(args.to, call.to) || lower(args.data) !== lower(call.data)
            || !args.value.isZero() || args.operation !== 0 || !args.safeTxGas.isZero()
            || !args.baseGas.isZero() || !args.gasPrice.isZero() || !same(args.gasToken, ZERO)
            || !same(args.refundReceiver, ZERO) || !/^0x[\da-f]{130}$/i.test(args.signatures)) return null;
        const message = Object.fromEntries(safeTypes.SafeTx.map(({ name }) =>
            [name, name === 'nonce' ? transfer.safeNonce : args[name]]));
        const safeHash = lower(ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, safeTypes, message));
        if (transfer.safeHash !== undefined && lower(transfer.safeHash) !== safeHash) return null;
        const signature = ethers.utils.splitSignature(args.signatures);
        if (![31, 32].includes(signature.v) || BigInt(signature.r) === 0n
            || BigInt(signature.s) === 0n || BigInt(signature.s) > HALF_ORDER) return null;
        const signer = ethers.utils.recoverAddress(ethers.utils.hashMessage(ethers.utils.arrayify(safeHash)),
            { r: signature.r, s: signature.s, v: signature.v - 4 });
        if (!same(signer, tx.from)) return null;
        return { tx, safeHash, signer: lower(signer), token: lower(transfer.token),
            recipient: lower(transfer.recipient), amountUnits: expected.toString() };
    } catch { return null; }
}

function canonicalEvent(iface, name, log) {
    const parsed = iface.parseLog(log), encoded = iface.encodeEventLog(iface.getEvent(name), [...parsed.args]);
    if (parsed.name !== name || lower(encoded.data) !== lower(log.data) || encoded.topics.length !== log.topics.length
        || encoded.topics.some((topic, index) => lower(topic) !== lower(log.topics[index]))) throw new Error('noncanonical_event');
    return parsed.args;
}

// The caller supplies a receipt already anchored to its canonical RPC block.
// Only a complete proof returns accounting deltas. Native gas is separate from
// token cash; the caller persists this proof once before marking it terminal.
export function verifyProfitTransferReceipt({ wallet, block, transfer, receipt } = {}) {
    try {
        const identity = persistedProfitTransferIdentity({ wallet, transfer });
        if (!identity || !Number.isSafeInteger(block) || block < 0 || !receipt
            || lower(receipt.transactionHash) !== lower(transfer.hash) || !HASH.test(receipt.blockHash || '')
            || lower(receipt.blockHash) === lower(ethers.constants.HashZero) || !same(receipt.to, wallet)
            || !same(receipt.from, identity.signer) || ![0, 1].includes(receipt.status)
            || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > block
            || !Number.isSafeInteger(receipt.transactionIndex) || receipt.transactionIndex < 0
            || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2 || !Array.isArray(receipt.logs)
            || receipt.chainId !== undefined && receipt.chainId !== 137
            || receipt.type !== undefined && receipt.type !== (identity.tx.type ?? 0)) return null;
        const expected = BigInt(identity.amountUnits), executions = [], nativeFees = [];
        let transfers = 0, previous = -1, nonFeeLogs = 0;
        const touches = args => same(args.from, wallet) || same(args.to, wallet)
            || same(args.from, identity.recipient) || same(args.to, identity.recipient);
        for (const log of receipt.logs) {
            if (!ADDRESS.test(log?.address || '') || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0
                || log.logIndex <= previous || log.removed === true || !Array.isArray(log.topics)
                || log.topics.length > 4 || log.topics.some(topic => !HASH.test(topic)) || !HEX.test(log.data || '')
                || log.transactionHash !== undefined && lower(log.transactionHash) !== lower(transfer.hash)
                || log.blockHash !== undefined && lower(log.blockHash) !== lower(receipt.blockHash)
                || log.blockNumber !== undefined && log.blockNumber !== receipt.blockNumber
                || log.transactionIndex !== undefined && log.transactionIndex !== receipt.transactionIndex) return null;
            previous = log.logIndex;
            const topic = lower(log.topics[0]);
            if (same(log.address, nativeToken) && topic === nativeFeeTopic) {
                // Polygon's fee hook survives an outer revert. Its amount is
                // the validator fee, which can be smaller than total gas.
                const args = canonicalEvent(native, 'LogFeeTransfer', log), fee = uint(args.amount);
                if (!same(args.token, nativeToken) || !same(args.from, identity.signer) || !address(args.to)
                    || same(args.to, wallet) || same(args.to, identity.signer)
                    || uint(args.input1) - uint(args.output1) !== fee
                    || uint(args.output2) - uint(args.input2) !== fee) return null;
                nativeFees.push(fee);
                continue;
            }
            nonFeeLogs++;
            if (same(log.address, wallet) && [successTopic, failureTopic].includes(topic)) {
                const name = topic === successTopic ? 'ExecutionSuccess' : 'ExecutionFailure';
                const args = canonicalEvent(safe, name, log);
                if (lower(args.txHash) !== identity.safeHash || !args.payment.isZero()) return null;
                executions.push(name);
            } else if (topic === transferTopic) {
                const nft = log.topics.length === 4;
                const args = canonicalEvent(nft ? erc721 : erc20, 'Transfer', log);
                if (!touches(args)) continue;
                if (nft || !same(log.address, identity.token) || !same(args.from, wallet)
                    || !same(args.to, identity.recipient) || uint(args.value) !== expected) return null;
                transfers++;
            } else if ([singleTopic, batchTopic].includes(topic)) {
                const args = canonicalEvent(erc1155, topic === singleTopic ? 'TransferSingle' : 'TransferBatch', log);
                if (touches(args)) return null;
            }
        }
        const success = receipt.status === 1 && executions.length === 1 && executions[0] === 'ExecutionSuccess' && transfers === 1;
        const failure = receipt.status === 0 && nonFeeLogs === 0
            || receipt.status === 1 && executions.length === 1 && executions[0] === 'ExecutionFailure' && transfers === 0;
        if (!success && !failure) return null;
        const used = uint(receipt.gasUsed), price = uint(receipt.effectiveGasPrice), cap = uint(identity.tx.gasPrice ?? identity.tx.maxFeePerGas);
        if (used <= 0n || used > uint(identity.tx.gasLimit) || price <= 0n || price > cap
            || identity.tx.gasPrice && price !== uint(identity.tx.gasPrice)
            || identity.tx.type === 2 && price < uint(identity.tx.maxPriorityFeePerGas)) return null;
        const gasWei = used * price;
        if (nativeFees.length > 1 || nativeFees.some(fee => fee > gasWei)) return null;
        const gasNative = Number(ethers.utils.formatEther(gasWei.toString()));
        const gas = gasNative * transfer.polUsd;
        if (!Number.isFinite(gasNative) || !Number.isFinite(gas) || gas <= 0) return null;
        const moved = success ? transfer.amount : 0;
        return { hash: lower(transfer.hash), safeHash: identity.safeHash, signer: identity.signer,
            safeNonce: transfer.safeNonce, status: success ? 'confirmed' : 'failed',
            token: identity.token, recipient: identity.recipient, amount: transfer.amount,
            cash: moved ? -moved : 0, safeTokenDelta: moved ? -moved : 0, recipientTokenDelta: moved,
            gas, gasNative, gasWei: gasWei.toString(),
            blockNumber: receipt.blockNumber, blockHash: lower(receipt.blockHash), transactionIndex: receipt.transactionIndex };
    } catch { return null; }
}
