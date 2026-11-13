import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { LayaTradingClient } from '../../src/laya-live/client.js';
import { persistedActionIdentity } from '../../src/laya-live/actions.js';
import { OperationalError } from '../../src/restart/network.js';

// Synthetic keys and in-memory RPCs only. No real settings or network writes.
const privateKey = '0x' + '7'.repeat(64), wallet = '0x' + '1'.repeat(40);
const conditionId = '0x' + 'e'.repeat(64), blockHash = '0x' + 'c'.repeat(64);
const position = { market: { conditionId, negRisk: false } };
const safe = new ethers.utils.Interface([
    'function nonce() view returns(uint256)',
    'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
]);
const fields = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));
const gwei = value => ethers.utils.parseUnits(String(value), 'gwei');
const hex = value => ethers.utils.hexValue(value);

function fixture(changes = {}) {
    const calls = [], writes = [];
    const values = { confirmed: '0x143', pending: '0x143', balance: hex(ethers.utils.parseEther('5')),
        priority: hex(gwei(30)), gasPrice: hex(gwei(175)), baseFee: gwei(145), chain: '0x89', ...changes };
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
                const message = Object.fromEntries(fields.map((field, index) => [field.name, parsed.args[index]]));
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
    const primary = { send: async () => assert.fail('Unselected primary must not receive a write') };
    const client = Object.create(LayaTradingClient.prototype);
    client.settings = { privateKey, wallet };
    client.rpc = { anchor: { number: 100, hash: blockHash }, active: 1, providers: [primary, provider],
        async validate(p, anchor) {
            assert.equal(p, provider);
            if (Number(await p.send('eth_chainId', [])) !== 137) throw new OperationalError('rpc_wrong_chain');
            if ((await p.getBlock(anchor.number)).hash !== anchor.hash) throw new OperationalError('rpc_block_mismatch');
        },
        async read(stage, task, block) { assert.equal(stage, 'safe_action_prepare'); assert.equal(block, 100); return task(provider, 100); },
    };
    client.confirmedBlock = async () => 100;
    client.gasPriceUsd = async () => .1;
    client.provider = { sendTransaction: async () => assert.fail('Inherited write provider must never be used') };
    return { client, provider, calls, writes, values };
}

test('preparation signs explicit Polygon EIP1559 fields from the validated selected endpoint without broadcasting', async () => {
    const f = fixture();
    const action = await f.client.prepareAction(position, 'redeem', 0), tx = ethers.utils.parseTransaction(action.raw);
    assert.equal(tx.chainId, 137); assert.equal(tx.type, 2); assert.equal(tx.nonce, 323);
    assert.equal(tx.maxPriorityFeePerGas.toString(), gwei(30).toString());
    assert.equal(tx.maxFeePerGas.toString(), gwei(320).toString());
    assert.equal(tx.gasLimit.toString(), '500000'); assert.equal(action.safeNonce, '474');
    assert.equal(action.broadcastRpcIndex, 1); assert.equal(action.hash, tx.hash);
    assert.ok(persistedActionIdentity({ position, wallet, action }));
    assert.equal(f.writes.length, 0);
    assert.ok(f.calls.some(([method, params]) => method === 'eth_getTransactionCount' && params[1] === 'pending'));
    assert.ok(f.calls.filter(([method]) => ['eth_getBalance', 'eth_call'].includes(method)).every(([, params]) => params[1] === '0x64'));
});

test('merge uses the same bound Safe action and fee recommendation when gasPrice exceeds projected base fee', async () => {
    const f = fixture({ gasPrice: hex(gwei(400)) });
    const action = await f.client.prepareAction(position, 'merge', 2);
    assert.equal(ethers.utils.parseTransaction(action.raw).maxFeePerGas.toString(), gwei(400).toString());
    assert.ok(persistedActionIdentity({ position, wallet, action }));
    assert.equal(f.writes.length, 0);
});

for (const [name, changes, code] of [
    ['regressed pending nonce', { pending: '0x142' }, 'action_nonce_regressed'],
    ['noncanonical pending nonce', { pending: '0x0143' }, 'invalid_action_nonce'],
    ['unsafe pending nonce', { pending: '0x20000000000000' }, 'invalid_action_nonce'],
    ['zero priority', { priority: '0x0' }, 'invalid_action_fee'],
    ['malformed priority', { priority: 'NaN' }, 'invalid_action_fee'],
    ['priority above gas quote', { priority: hex(gwei(200)) }, 'invalid_action_fee'],
    ['missing London base fee', { baseFee: null }, 'invalid_action_fee'],
    ['excessive recommendation', { gasPrice: hex(gwei(1001)) }, 'invalid_action_fee'],
    ['excessive projected fee', { baseFee: gwei(500) }, 'action_fee_limit'],
    ['insufficient maximum gas cost', { balance: hex(ethers.utils.parseEther('.1')) }, 'insufficient_action_gas'],
    ['wrong chain', { chain: '0x1' }, 'rpc_wrong_chain'],
    ['unbound Safe hash', { safeHash: '0x' + '0'.repeat(64) }, 'action_safe_hash_mismatch'],
]) test(`preparation rejects ${name} before signing`, async t => {
    const f = fixture(changes);
    t.mock.method(ethers.Wallet.prototype, 'signMessage', async () => assert.fail('Invalid preparation must not sign'));
    await assert.rejects(f.client.prepareAction(position, 'redeem', 0), error => error.code === code);
    assert.equal(f.writes.length, 0);
});

test('preparation checks an exact native gas balance boundary and rejects an invalid quote before signing', async t => {
    const f = fixture({ balance: hex(gwei(320).mul(500000)) });
    assert.equal((await f.client.prepareAction(position, 'redeem', 0)).status, 'prepared');
    f.client.gasPriceUsd = async () => Infinity;
    t.mock.method(ethers.Wallet.prototype, 'signMessage', async () => assert.fail('Invalid quote must not sign'));
    await assert.rejects(f.client.prepareAction(position, 'redeem', 0), error => error.code === 'invalid_action_gas_quote');
});

test('insufficient gas reports the exact reserve shortfall without signing or leaking transaction data', async t => {
    const f = fixture({ balance: hex(ethers.utils.parseEther('.1')) }), events = [];
    f.client.onEvent = event => events.push(event);
    t.mock.method(ethers.Wallet.prototype, 'signMessage', async () => assert.fail('No Safe signature without gas'));
    t.mock.method(ethers.Wallet.prototype, 'signTransaction', async () => assert.fail('No transaction signature without gas'));
    await assert.rejects(f.client.prepareAction(position, 'redeem', 0), error =>
        error.code === 'insufficient_action_gas' && error.category === 'validation' && error.stage === 'safe_action_prepare');
    assert.deepEqual(events, [{ type: 'action_gas_unavailable', kind: 'redeem', blockNumber: 100,
        availablePOL: '0.1', requiredPOL: '0.16', shortfallPOL: '0.06' }]);
    assert.deepEqual(f.writes, []);
    assert.ok(!f.calls.some(([method, params]) => method === 'eth_call'
        && safe.parseTransaction(params[0]).name === 'getTransactionHash'));
});

test('broadcast uses the persisted endpoint exactly once even when active provider selection changes', async () => {
    const f = fixture(), action = await f.client.prepareAction(position, 'redeem', 0);
    f.client.rpc.active = 0;
    assert.deepEqual(await f.client.broadcastAction(action), { hash: action.hash });
    assert.deepEqual(f.writes, [action.raw]);
});

test('broadcast sanitizes an uncertain HTTP403 and never retries or switches endpoints', async () => {
    const secret = 'signed-payload-and-token-url-must-not-escape';
    const f = fixture(), action = await f.client.prepareAction(position, 'redeem', 0);
    f.values.writeError = Object.assign(new Error(secret), { status: 403, requestBody: secret });
    await assert.rejects(f.client.broadcastAction(action), error => {
        assert.equal(error.code, 'http_rejected'); assert.equal(error.category, 'api_rejection'); assert.equal(error.httpStatus, 403);
        assert.equal(JSON.stringify(error).includes(secret), false); assert.equal(error.message.includes(secret), false); return true;
    });
    assert.deepEqual(f.writes, [action.raw]);
});

test('broadcast validates the persisted hash and endpoint before writing, then requires the exact returned hash', async () => {
    const f = fixture(), action = await f.client.prepareAction(position, 'redeem', 0);
    await assert.rejects(f.client.broadcastAction({ ...action, hash: '0x' + '0'.repeat(64) }), error => error.code === 'invalid_action_transaction');
    await assert.rejects(f.client.broadcastAction({ ...action, broadcastRpcIndex: 99 }), error => error.code === 'invalid_action_endpoint');
    assert.equal(f.writes.length, 0);
    f.values.responseHash = '0x' + '0'.repeat(64);
    await assert.rejects(f.client.broadcastAction(action), error => error.code === 'action_submission_hash_mismatch');
    assert.deepEqual(f.writes, [action.raw]);
});

test('broadcast validates chain and anchor without sending after validation fails', async () => {
    const f = fixture(), action = await f.client.prepareAction(position, 'redeem', 0);
    f.values.chain = '0x1';
    await assert.rejects(f.client.broadcastAction(action), error => error.code === 'rpc_wrong_chain');
    assert.equal(f.writes.length, 0);
});
