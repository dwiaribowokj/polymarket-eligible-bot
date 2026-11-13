import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { profitTransferCall, persistedProfitTransferIdentity, verifyProfitTransferReceipt } from '../../src/laya-live/profit-transaction.js';

// Offline synthetic identities only. No settings, live keys, providers, or RPCs.
const owner = new ethers.Wallet('0x' + '7'.repeat(64)), otherOwner = new ethers.Wallet('0x' + '8'.repeat(64));
const wallet = '0x' + '1'.repeat(40), token = '0x' + '2'.repeat(40), other = '0x' + '3'.repeat(40);
const recipient = owner.address, blockHash = '0x' + 'a'.repeat(64), otherHash = '0x' + 'b'.repeat(64);
const zero = ethers.constants.AddressZero, nativeToken = '0x0000000000000000000000000000000000001010';
const now = 1780000300000, gwei = value => ethers.utils.parseUnits(String(value), 'gwei');
const safe = new ethers.utils.Interface([
    'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures)',
    'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)',
]);
const erc20 = new ethers.utils.Interface([
    'function transfer(address to,uint256 value) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const erc721 = new ethers.utils.Interface(['event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const erc1155 = new ethers.utils.Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
]);
const native = new ethers.utils.Interface([
    'event LogFeeTransfer(address indexed token,address indexed from,address indexed to,uint256 amount,uint256 input1,uint256 input2,uint256 output1,uint256 output2)',
]);
const fields = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));
const log = (iface, event, address, args, logIndex) => ({ address, logIndex,
    ...iface.encodeEventLog(iface.getEvent(event), args) });
const cash = (address = token, from = wallet, to = recipient, value = 5000000, index = 10) =>
    log(erc20, 'Transfer', address, [from, to, value], index);
const nativeFee = (index = 30, changes = {}) => {
    const fee = { token: nativeToken, from: recipient, to: other, amount: gwei(3), input1: gwei(1000), input2: gwei(100),
        output1: gwei(997), output2: gwei(103), ...changes };
    return log(native, 'LogFeeTransfer', nativeToken,
        ['token', 'from', 'to', 'amount', 'input1', 'input2', 'output1', 'output2'].map(name => fee[name]), index);
};

async function fixture(overrides = {}) {
    const intent = { token, recipient, amount: 5, ...overrides.intent };
    const call = profitTransferCall(intent), message = { to: call.to, value: 0, data: call.data, operation: 0,
        safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: zero, refundReceiver: zero, nonce: '7', ...overrides.safe };
    const safeHash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, { SafeTx: fields }, message);
    const sig = ethers.utils.splitSignature(await (overrides.innerSigner || owner).signMessage(ethers.utils.arrayify(safeHash)));
    const signature = overrides.signature || ethers.utils.hexConcat([sig.r, sig.s, ethers.utils.hexlify(sig.v + 4)]);
    const data = safe.encodeFunctionData('execTransaction', fields.slice(0, 9).map(({ name }) => message[name]).concat(signature));
    const txFields = { to: wallet, value: 0, data, chainId: 137, type: 2, nonce: 11, gasLimit: 500000,
        maxFeePerGas: gwei(320), maxPriorityFeePerGas: gwei(30), ...overrides.tx };
    if (txFields.type === 0) { delete txFields.maxFeePerGas; delete txFields.maxPriorityFeePerGas; txFields.gasPrice ??= gwei(175); }
    const raw = await (overrides.outerSigner || owner).signTransaction(txFields);
    const transfer = { kind: 'profit_transfer', ...intent, hash: ethers.utils.keccak256(raw), raw,
        safeNonce: message.nonce, polUsd: .1, createdAt: now, status: 'unknown', ...overrides.transfer };
    const receipt = { transactionHash: transfer.hash, from: (overrides.outerSigner || owner).address, to: wallet,
        blockHash, blockNumber: 100, transactionIndex: 2, confirmations: 3, status: 1, type: txFields.type,
        gasUsed: ethers.BigNumber.from(100000), effectiveGasPrice: gwei(175),
        logs: [cash(intent.token, wallet, intent.recipient, Math.round(intent.amount * 1e6)),
            log(safe, 'ExecutionSuccess', wallet, [safeHash, 0], 20)] };
    return { transfer, receipt, safeHash, input: { wallet, block: 100, transfer, receipt } };
}

test('builds exactly the configured ERC20 transfer with integer six-decimal units', () => {
    for (const amount of [5, .000001, 1.234567, 9007199254]) {
        const call = profitTransferCall({ token, recipient, amount });
        assert.equal(call.to, token);
        assert.equal(call.data, erc20.encodeFunctionData('transfer', [recipient, String(Math.round(amount * 1e6))]));
    }
});

test('rejects invalid intent addresses and amounts before constructing calldata', () => {
    for (const values of [{ token: zero }, { recipient: zero }, { token: 'bad' }, { recipient: token },
        { amount: 0 }, { amount: -5 }, { amount: .0000001 }, { amount: 5.0000001 }, { amount: 1e12 },
        { amount: NaN }, { amount: Infinity }, { amount: '5' }, { amount: null }])
        assert.throws(() => profitTransferCall({ token, recipient, amount: 5, ...values }));
    assert.throws(() => profitTransferCall());
});

test('signed identity binds exact Polygon Safe, payload, sender and nonce for both explicit fee types', async () => {
    for (const type of [0, 2]) {
        const f = await fixture({ tx: { type } }), identity = persistedProfitTransferIdentity(f.input);
        assert.ok(identity); assert.equal(identity.safeHash, f.safeHash.toLowerCase());
        assert.equal(identity.signer, recipient.toLowerCase()); assert.equal(identity.token, token);
        assert.equal(identity.recipient, recipient.toLowerCase()); assert.equal(identity.amountUnits, '5000000');
        assert.equal(identity.tx.chainId, 137); assert.equal(identity.tx.nonce, 11);
    }
});

test('persisted metadata mutations cannot authorize the signed transfer', async () => {
    const changes = { hash: otherHash, raw: '0x', safeNonce: '8', token: other, recipient: other, amount: 4,
        polUsd: 0, createdAt: NaN, kind: 'merge', safeHash: otherHash };
    for (const [name, value] of Object.entries(changes)) {
        const f = await fixture(); f.transfer[name] = value;
        assert.equal(persistedProfitTransferIdentity(f.input), null, name);
        assert.equal(verifyProfitTransferReceipt(f.input), null, name);
    }
    for (const safeNonce of ['07', '-1', '', '1.5', String(1n << 256n), 7]) {
        const f = await fixture(); f.transfer.safeNonce = safeNonce;
        assert.equal(persistedProfitTransferIdentity(f.input), null, `safeNonce ${safeNonce}`);
    }
});

test('rejects signed Safe calls that differ in any authorized execution field', async () => {
    const changes = { to: other, data: '0x', value: 1, operation: 1, safeTxGas: 1, baseGas: 1,
        gasPrice: 1, gasToken: other, refundReceiver: other };
    for (const [name, value] of Object.entries(changes)) {
        const f = await fixture({ safe: { [name]: value } });
        assert.equal(persistedProfitTransferIdentity(f.input), null, name);
    }
    for (const overrides of [{ innerSigner: otherOwner }, { outerSigner: otherOwner }, { signature: '0x' },
        { signature: '0x' + '00'.repeat(65) }]) {
        const f = await fixture(overrides);
        assert.equal(persistedProfitTransferIdentity(f.input), null);
    }
});

test('rejects wrong outer transaction target, chain, value and excessive or invalid gas fields', async () => {
    for (const tx of [{ to: other }, { chainId: 1 }, { value: 1 }, { gasLimit: 0 }, { gasLimit: 500001 },
        { maxFeePerGas: gwei(1001) }, { maxPriorityFeePerGas: 0 },
        { type: 0, gasPrice: 0 }, { type: 0, gasPrice: gwei(1001) }]) {
        const f = await fixture({ tx }); assert.equal(persistedProfitTransferIdentity(f.input), null, JSON.stringify(tx));
    }
});

test('success proves one exact Safe-to-recipient ERC20 movement and separates native gas from token cash', async () => {
    const f = await fixture(), before = JSON.stringify(f.input), proof = verifyProfitTransferReceipt(f.input);
    assert.deepEqual(proof, { hash: f.transfer.hash, safeHash: f.safeHash.toLowerCase(), signer: recipient.toLowerCase(),
        safeNonce: '7', status: 'confirmed', token, recipient: recipient.toLowerCase(), amount: 5,
        cash: -5, safeTokenDelta: -5, recipientTokenDelta: 5, gas: .0175 * .1, gasNative: .0175,
        gasWei: '17500000000000000', blockNumber: 100, blockHash, transactionIndex: 2 });
    assert.equal(JSON.stringify(f.input), before);
    assert.deepEqual(verifyProfitTransferReceipt(f.input), proof, 'Repeated pure verification cannot change state');
    assert.equal(f.transfer.status, 'unknown', 'Caller must persist accounting before marking terminal');
});

test('canonical Polygon native fee event never counts as an ERC20 payout or a second gas charge', async () => {
    const f = await fixture(), plain = verifyProfitTransferReceipt(f.input);
    f.receipt.logs.push(nativeFee());
    assert.deepEqual(verifyProfitTransferReceipt(f.input), plain);
});

test('outer revert and exact Safe ExecutionFailure prove gas with zero token movement', async () => {
    for (const status of [0, 1]) for (const fee of [false, true]) {
        const f = await fixture(); f.receipt.status = status;
        f.receipt.logs = status ? [log(safe, 'ExecutionFailure', wallet, [f.safeHash, 0], 20)] : [];
        if (fee) f.receipt.logs.push(nativeFee());
        const proof = verifyProfitTransferReceipt(f.input);
        assert.equal(proof?.status, 'failed', `status ${status}, fee ${fee}`);
        assert.equal(proof.cash, 0); assert.equal(proof.safeTokenDelta, 0); assert.equal(proof.recipientTokenDelta, 0);
        assert.equal(proof.gasWei, '17500000000000000'); assert.equal(proof.gas, .0175 * .1);
        assert.equal(f.transfer.status, 'unknown');
    }
});

test('rejects canonical identity, finality, block and log metadata mismatches without gas proof', async () => {
    const mutations = {
        hash: r => { r.transactionHash = otherHash; }, from: r => { r.from = other; }, to: r => { r.to = other; },
        blockHash: r => { r.blockHash = 'bad'; }, zeroBlockHash: r => { r.blockHash = ethers.constants.HashZero; },
        futureBlock: r => { r.blockNumber = 101; }, negativeBlock: r => { r.blockNumber = -1; },
        transactionIndex: r => { r.transactionIndex = -1; }, confirmations: r => { r.confirmations = 1; },
        missingConfirmations: r => { delete r.confirmations; }, status: r => { r.status = '1'; },
        chain: r => { r.chainId = 1; }, type: r => { r.type = 0; },
        removed: r => { r.logs[0].removed = true; }, logHash: r => { r.logs[0].transactionHash = otherHash; },
        logBlockHash: r => { r.logs[0].blockHash = otherHash; }, logBlock: r => { r.logs[0].blockNumber = 99; },
        logTransactionIndex: r => { r.logs[0].transactionIndex = 1; },
        duplicateLogIndex: r => { r.logs[1].logIndex = r.logs[0].logIndex; },
        negativeLogIndex: r => { r.logs[0].logIndex = -1; }, invalidAddress: r => { r.logs[0].address = 'bad'; },
        invalidTopic: r => { r.logs[0].topics[0] = '0xab'; }, invalidData: r => { r.logs[0].data = '0x1'; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
        const f = await fixture(); mutate(f.receipt); assert.equal(verifyProfitTransferReceipt(f.input), null, name);
    }
});

test('rejects missing, duplicated, mismatched, noncanonical and paid Safe execution events', async () => {
    for (const change of ['missing', 'duplicate', 'hash', 'payment', 'trailing', 'topic']) {
        const f = await fixture();
        if (change === 'missing') f.receipt.logs.pop();
        if (change === 'duplicate') f.receipt.logs.push(log(safe, 'ExecutionSuccess', wallet, [f.safeHash, 0], 21));
        if (change === 'hash') f.receipt.logs[1] = log(safe, 'ExecutionSuccess', wallet, [otherHash, 0], 20);
        if (change === 'payment') f.receipt.logs[1] = log(safe, 'ExecutionSuccess', wallet, [f.safeHash, 1], 20);
        if (change === 'trailing') f.receipt.logs[1].data += '00'.repeat(32);
        if (change === 'topic') f.receipt.logs[1].topics.push(otherHash);
        assert.equal(verifyProfitTransferReceipt(f.input), null, change);
    }
});

test('rejects partial, split, extra and compensating ERC20 movements involving either wallet', async () => {
    for (const change of ['missing', 'amount', 'from', 'to', 'token', 'duplicate', 'split', 'safe_out', 'safe_in',
        'recipient_out', 'recipient_in', 'compensating', 'trailing', 'malformed', 'zero_extra']) {
        const f = await fixture();
        if (change === 'missing') f.receipt.logs.shift();
        if (change === 'amount') f.receipt.logs[0] = cash(token, wallet, recipient, 4999999);
        if (change === 'from') f.receipt.logs[0] = cash(token, other, recipient);
        if (change === 'to') f.receipt.logs[0] = cash(token, wallet, other);
        if (change === 'token') f.receipt.logs[0] = cash(other);
        if (change === 'duplicate') f.receipt.logs.splice(1, 0, cash(token, wallet, recipient, 5000000, 11));
        if (change === 'split') f.receipt.logs.splice(0, 1, cash(token, wallet, recipient, 2000000, 10), cash(token, wallet, recipient, 3000000, 11));
        if (change === 'safe_out') f.receipt.logs.splice(1, 0, cash(other, wallet, zero, 1, 11));
        if (change === 'safe_in') f.receipt.logs.splice(1, 0, cash(other, zero, wallet, 1, 11));
        if (change === 'recipient_out') f.receipt.logs.splice(1, 0, cash(other, recipient, zero, 1, 11));
        if (change === 'recipient_in') f.receipt.logs.splice(1, 0, cash(other, zero, recipient, 1, 11));
        if (change === 'compensating') f.receipt.logs.splice(1, 0, cash(other, wallet, zero, 1, 11), cash(other, zero, wallet, 1, 12));
        if (change === 'trailing') f.receipt.logs[0].data += '00'.repeat(32);
        if (change === 'malformed') f.receipt.logs[0].data = '0x';
        if (change === 'zero_extra') f.receipt.logs.splice(1, 0, cash(other, zero, recipient, 0, 11));
        assert.equal(verifyProfitTransferReceipt(f.input), null, change);
    }
});

test('rejects unrelated ERC721 and ERC1155 holdings movements involving Safe or recipient', async () => {
    for (const side of [wallet, recipient]) for (const type of ['nft', 'single', 'batch']) {
        const f = await fixture();
        const unexpected = type === 'nft' ? log(erc721, 'Transfer', other, [side, zero, 1], 11)
            : type === 'single' ? log(erc1155, 'TransferSingle', other, [other, zero, side, 1, 1], 11)
                : log(erc1155, 'TransferBatch', other, [other, zero, side, [1, 2], [1, 2]], 11);
        f.receipt.logs.splice(1, 0, unexpected);
        assert.equal(verifyProfitTransferReceipt(f.input), null, `${side} ${type}`);
    }
});

test('unrelated account transfers cannot alter the exact payout proof', async () => {
    const f = await fixture(), before = verifyProfitTransferReceipt(f.input);
    f.receipt.logs.splice(1, 0, cash(other, zero, other, 1, 11));
    assert.deepEqual(verifyProfitTransferReceipt(f.input), before);
});

test('a failed Safe execution or outer revert with ERC20 movement never books failure gas', async () => {
    for (const status of [0, 1]) {
        const f = await fixture(); f.receipt.status = status;
        if (status === 1) f.receipt.logs[1] = log(safe, 'ExecutionFailure', wallet, [f.safeHash, 0], 20);
        assert.equal(verifyProfitTransferReceipt(f.input), null);
    }
});

test('invalid gas usage, effective price and fee envelope never produce accounting proof', async () => {
    for (const type of [0, 2]) for (const change of ['zero_used', 'over_used', 'zero_price', 'over_cap', 'missing_used', 'missing_price', 'fractional_used', 'price_mismatch']) {
        const f = await fixture({ tx: { type } });
        if (change === 'zero_used') f.receipt.gasUsed = 0;
        if (change === 'over_used') f.receipt.gasUsed = 500001;
        if (change === 'zero_price') f.receipt.effectiveGasPrice = 0;
        if (change === 'over_cap') f.receipt.effectiveGasPrice = gwei(1001);
        if (change === 'missing_used') delete f.receipt.gasUsed;
        if (change === 'missing_price') delete f.receipt.effectiveGasPrice;
        if (change === 'fractional_used') f.receipt.gasUsed = 1.5;
        if (change === 'price_mismatch') f.receipt.effectiveGasPrice = type === 0 ? gwei(174) : gwei(29);
        assert.equal(verifyProfitTransferReceipt(f.input), null, `${type} ${change}`);
    }
});

test('invalid or spoofed native fee logs cannot pass canonical fee auditing', async () => {
    for (const change of ['token', 'from', 'to', 'debit', 'credit', 'over_gas', 'duplicate', 'trailing', 'erc20']) {
        const f = await fixture();
        const overrides = change === 'token' ? { token: other } : change === 'from' ? { from: other }
            : change === 'to' ? { to: wallet } : change === 'debit' ? { output1: gwei(996) }
                : change === 'credit' ? { output2: gwei(104) } : change === 'over_gas'
                    ? { amount: gwei(20000000), input1: gwei(20000001), input2: 0, output1: gwei(1), output2: gwei(20000000) } : {};
        f.receipt.logs.push(nativeFee(30, overrides));
        if (change === 'duplicate') f.receipt.logs.push(nativeFee(31));
        if (change === 'trailing') f.receipt.logs.at(-1).data += '00'.repeat(32);
        if (change === 'erc20') f.receipt.logs[f.receipt.logs.length - 1] = cash(nativeToken, recipient, other, 1, 30);
        assert.equal(verifyProfitTransferReceipt(f.input), null, change);
    }
});

test('full log metadata and uppercase hashes remain bound without mutating input', async () => {
    const f = await fixture();
    for (const entry of f.receipt.logs) Object.assign(entry, { transactionHash: f.transfer.hash.toUpperCase().replace('0X', '0x'),
        blockHash, blockNumber: 100, transactionIndex: 2, removed: false });
    assert.equal(verifyProfitTransferReceipt(f.input)?.status, 'confirmed');
});
