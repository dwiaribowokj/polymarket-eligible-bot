import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { profitTransferCall, persistedProfitTransferIdentity } from '../../src/laya-live/profit-transaction.js';
import { CONTRACTS } from '../../src/restart/client.js';
import { OperationalError } from '../../src/restart/network.js';

// Synthetic fixture keys and in-memory RPCs only. No live settings or network.
const privateKey = '0x' + '7'.repeat(64), owner = new ethers.Wallet(privateKey);
const wallet = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), other = '0x' + '3'.repeat(40);
const blockHash = '0x' + 'a'.repeat(64), token = CONTRACTS.collateralToken;
const intent = { token, recipient, amount: 5 };
const gwei = value => ethers.utils.parseUnits(String(value), 'gwei'), hex = value => ethers.utils.hexValue(value);
const safe = new ethers.utils.Interface([
    'function nonce() view returns(uint256)',
    'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
]);
const fields = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));

function fixture(changes = {}) {
    const calls = [], writes = [], stages = [];
    const values = { pending: '0x143', confirmed: '0x143', priority: hex(gwei(30)), gasPrice: hex(gwei(175)),
        baseFee: gwei(145), balance: hex(ethers.utils.parseEther('5')), chain: '0x89', ...changes };
    const provider = {
        async getBlock(number) { calls.push(['block', number]); return { number, hash: blockHash, baseFeePerGas: values.baseFee }; },
        async send(method, params) {
            calls.push([method, params]);
            if (method === 'eth_chainId') return values.chain;
            if (method === 'eth_getTransactionCount') return params[1] === 'pending' ? values.pending : values.confirmed;
            if (method === 'eth_getBalance') return values.balance;
            if (method === 'eth_maxPriorityFeePerGas') return values.priority;
            if (method === 'eth_gasPrice') return values.gasPrice;
            if (method === 'eth_call') {
                const parsed = safe.parseTransaction(params[0]);
                if (parsed.name === 'nonce') return safe.encodeFunctionResult('nonce', [474]);
                const message = Object.fromEntries(fields.map(({ name }, index) => [name, parsed.args[index]]));
                const hash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: wallet }, { SafeTx: fields }, message);
                return safe.encodeFunctionResult('getTransactionHash', [values.safeHash || hash]);
            }
            if (method === 'eth_sendRawTransaction') {
                writes.push(params[0]);
                if (values.writeError) throw values.writeError;
                return values.responseHash || ethers.utils.keccak256(params[0]);
            }
            assert.fail(`Unexpected RPC ${method}`);
        },
    };
    const primary = { send: async () => assert.fail('Unselected endpoint must not receive a write') };
    const client = Object.create(LayaTradingClient.prototype);
    client.settings = { privateKey, wallet };
    client.rpc = { anchor: { number: 100, hash: blockHash }, active: 1, providers: [primary, provider],
        async validate(p, anchor) {
            assert.equal(p, provider);
            if (Number(await p.send('eth_chainId', [])) !== 137) throw new OperationalError('rpc_wrong_chain');
            if ((await p.getBlock(anchor.number)).hash !== anchor.hash) throw new OperationalError('rpc_block_mismatch');
        },
        async read(stage, task, block) { stages.push(stage); assert.equal(block, 100); return task(provider, block); },
    };
    client.confirmedBlock = async () => 100;
    client.gasPriceUsd = async () => values.polUsd ?? .1;
    client.provider = { sendTransaction: async () => assert.fail('Inherited write provider must never be used') };
    client.authenticate = async () => assert.fail('A Safe transfer must not authenticate the trading API');
    return { client, provider, calls, writes, values, stages };
}

test('pUSD profit preparation uses the shared explicit Safe envelope and returns an exact signed intent without broadcasting', async () => {
    const f = fixture(), transfer = await f.client.prepareProfitTransfer(intent), tx = ethers.utils.parseTransaction(transfer.raw);
    assert.equal(transfer.kind, 'profit_transfer'); assert.equal(transfer.token, token);
    assert.equal(transfer.recipient, recipient); assert.equal(transfer.amount, 5);
    assert.equal(transfer.hash, tx.hash); assert.equal(transfer.safeNonce, '474');
    assert.equal(transfer.status, 'prepared'); assert.equal(transfer.polUsd, .1);
    assert.equal(transfer.broadcastRpcIndex, 1); assert.equal(Number.isSafeInteger(transfer.createdAt), true);
    assert.equal(tx.chainId, 137); assert.equal(tx.type, 2); assert.equal(tx.nonce, 323);
    assert.equal(tx.to.toLowerCase(), wallet); assert.equal(tx.from, owner.address); assert.equal(tx.value.toString(), '0');
    assert.equal(tx.gasLimit.toString(), '500000'); assert.equal(tx.maxFeePerGas.toString(), gwei(320).toString());
    assert.equal(tx.maxPriorityFeePerGas.toString(), gwei(30).toString());
    assert.ok(persistedProfitTransferIdentity({ wallet, transfer }));
    assert.ok(transfer.maxGasUsd >= .016 && transfer.maxGasUsd <= .016001);
    assert.deepEqual(f.stages, ['safe_action_prepare']); assert.deepEqual(f.writes, []);
    assert.ok(f.calls.filter(([method]) => ['eth_call', 'eth_getBalance'].includes(method)).every(([, params]) => params[1] === '0x64'));
});

test('profit preparation accepts a fresh source address different from the gas payer and a case-equivalent pUSD address', async () => {
    const f = fixture(), transfer = await f.client.prepareProfitTransfer({ ...intent, token: token.toLowerCase(), amount: .000001 });
    assert.equal(transfer.recipient, recipient); assert.equal(transfer.amount, .000001);
    assert.ok(persistedProfitTransferIdentity({ wallet, transfer })); assert.equal(f.writes.length, 0);
});

test('invalid token, recipient and amount reject before RPCs or signing', async t => {
    const f = fixture();
    f.client.confirmedBlock = async () => assert.fail('Invalid profit intent must not read RPC state');
    t.mock.method(ethers.Wallet.prototype, 'signMessage', async () => assert.fail('Invalid intent must not sign'));
    for (const changes of [{ token: other }, { token: ethers.constants.AddressZero }, { token: null },
        { recipient: wallet }, { recipient: token }, { recipient: ethers.constants.AddressZero }, { recipient: 'bad' },
        { amount: 0 }, { amount: -5 }, { amount: 5.0000001 }, { amount: Infinity }, { amount: '5' }])
        await assert.rejects(f.client.prepareProfitTransfer({ ...intent, ...changes }), error => error.code === 'invalid_profit_transfer_request');
    await assert.rejects(f.client.prepareProfitTransfer(), error => error.code === 'invalid_profit_transfer_request');
    await assert.rejects(f.client.prepareProfitTransfer(null), error => error.code === 'invalid_profit_transfer_request');
    assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
});

test('malformed generic calls and profit call/identity mismatches reject before signing or RPCs', async t => {
    const f = fixture(), call = profitTransferCall(intent), identity = { kind: 'profit_transfer', ...intent };
    f.client.confirmedBlock = async () => assert.fail('Malformed call must not read RPC state');
    t.mock.method(ethers.Wallet.prototype, 'signMessage', async () => assert.fail('Malformed call must not sign'));
    for (const malformed of [null, {}, { ...call, to: 'bad' }, { ...call, to: ethers.constants.AddressZero },
        { ...call, data: '0x' }, { ...call, data: '0x1' }, { ...call, data: '0xgg' },
        { ...call, value: 1 }, { ...call, operation: 1 }, { ...call, data: '0x1234' },
        { ...call, to: other }])
        await assert.rejects(f.client.prepareSafeCall(malformed, identity), error => error.code === 'invalid_action_request');
    for (const changes of [{ kind: 'unknown' }, { token: other }, { recipient: wallet }, { amount: 4 }])
        await assert.rejects(f.client.prepareSafeCall(call, { ...identity, ...changes }), error => error.code === 'invalid_action_request');
    assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
});

test('shared preparation snapshots call and identity before asynchronous reads', async () => {
    const f = fixture(), call = profitTransferCall(intent), identity = { kind: 'profit_transfer', ...intent };
    f.client.confirmedBlock = async () => { call.to = other; call.data = '0x'; identity.amount = 50; identity.recipient = other; return 100; };
    const transfer = await f.client.prepareSafeCall(call, identity);
    assert.equal(transfer.amount, 5); assert.equal(transfer.recipient, recipient);
    assert.ok(persistedProfitTransferIdentity({ wallet, transfer })); assert.equal(f.writes.length, 0);
});

for (const [name, changes, code] of [
    ['wrong chain', { chain: '0x1' }, 'rpc_wrong_chain'],
    ['regressed pending nonce', { pending: '0x142' }, 'action_nonce_regressed'],
    ['noncanonical pending nonce', { pending: '0x0143' }, 'invalid_action_nonce'],
    ['wrong Safe hash', { safeHash: '0x' + '0'.repeat(64) }, 'action_safe_hash_mismatch'],
    ['excessive gas recommendation', { gasPrice: hex(gwei(1001)) }, 'invalid_action_fee'],
    ['insufficient maximum gas balance', { balance: hex(ethers.utils.parseEther('.1')) }, 'insufficient_action_gas'],
    ['invalid POL price', { polUsd: 0 }, 'invalid_action_gas_quote'],
]) test(`profit preparation rejects ${name} before signing`, async t => {
    const f = fixture(changes);
    t.mock.method(ethers.Wallet.prototype, 'signMessage', async () => assert.fail('Invalid preparation must not sign'));
    await assert.rejects(f.client.prepareProfitTransfer(intent), error => error.code === code);
    assert.equal(f.stages.length, 1); assert.equal(f.writes.length, 0);
});

test('maximum gas reserve follows the signed fee cap rather than an estimate or effective gas cost', async () => {
    const f = fixture({ gasPrice: hex(gwei(400)), polUsd: .333333 });
    const transfer = await f.client.prepareProfitTransfer(intent), tx = ethers.utils.parseTransaction(transfer.raw);
    const maximum = Number(ethers.utils.formatEther(tx.gasLimit.mul(tx.maxFeePerGas))) * transfer.polUsd;
    assert.equal(tx.maxFeePerGas.toString(), gwei(400).toString());
    assert.ok(transfer.maxGasUsd >= maximum); assert.ok(transfer.maxGasUsd - maximum < .0000011);
    assert.equal(f.writes.length, 0);
});

test('profit broadcast performs one write to the persisted selected endpoint with no fallback', async () => {
    const f = fixture(), transfer = await f.client.prepareProfitTransfer(intent);
    f.client.rpc.active = 0;
    assert.deepEqual(await f.client.broadcastAction(transfer), { hash: transfer.hash });
    assert.deepEqual(f.writes, [transfer.raw]);
});

test('uncertain profit broadcast errors stay sanitized and never retry or switch endpoints', async () => {
    const f = fixture(), transfer = await f.client.prepareProfitTransfer(intent);
    f.client.rpc.active = 0;
    const secret = 'signed-transfer-payload-must-not-escape';
    f.values.writeError = Object.assign(new Error(secret), { code: 'ECONNRESET', requestBody: secret });
    await assert.rejects(f.client.broadcastAction(transfer), error => {
        assert.equal(error.code, 'transport_failed'); assert.equal(JSON.stringify(error).includes(secret), false); return true;
    });
    assert.deepEqual(f.writes, [transfer.raw]);
    assert.equal(f.calls.filter(([method]) => method === 'eth_sendRawTransaction').length, 1);
});

test('profit broadcast rejects a changed persisted hash or endpoint before writing', async () => {
    const f = fixture(), transfer = await f.client.prepareProfitTransfer(intent);
    await assert.rejects(f.client.broadcastAction({ ...transfer, hash: '0x' + '0'.repeat(64) }), error => error.code === 'invalid_action_transaction');
    await assert.rejects(f.client.broadcastAction({ ...transfer, broadcastRpcIndex: 9 }), error => error.code === 'invalid_action_endpoint');
    assert.deepEqual(f.writes, []);
});
