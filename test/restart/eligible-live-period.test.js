import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ethers } from 'ethers';
import { BASELINE } from '../../src/restart/config.js';
import { Store, atomicJson, acquireLock } from '../../src/restart/store.js';
import { bindRiskPeriod, createRiskPeriod, validateRiskPeriodHistory, readPeriodWalletProof } from '../../src/eligible-live/period.js';
import { eligibleHistory, eligibleReadiness, eligiblePreflight, previousLiveSummary,
    allocateLiveCapital } from '../../src/eligible-live/preflight.js';
import { CONTRACTS } from '../../src/restart/client.js';

const runtimeId = '0011223344556677', priorId = '8899aabbccddeeff';
const wallet = `0x${'b'.repeat(40)}`, blockHash = `0x${'a'.repeat(64)}`;
const safeNonce = number => ethers.utils.defaultAbiCoder.encode(['uint256'], [number]);

function fixture(t, options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eligible-period-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const settings = { ...BASELINE, fingerprint: runtimeId, wallet, privateKey: `0x${'1'.repeat(64)}`,
        capital: 0, drawdownStop: 10, pilotMarkets: Infinity, pilotHours: Infinity, dataDir };
    const config = { id: runtimeId, runtimeId, settings,
        policy: { provider: 'eligible', drawdownStop: 10 }, ai: { id: runtimeId, control: settings },
        profitTaking: { enabled: false }, paperEvidence: { qualified: false } };
    const old = new Store({ ...settings, fingerprint: priorId, capital: 20 }, 'pilot', 'late-entry');
    Object.assign(old.state, { decisionProvider: 'laya', startedAt: 1000, cash: 12, peakEquity: 23,
        maxDrawdown: 11, walletStart: 20, walletCashDelta: -8, liveFunding: { initialCapital: 20 },
        stopped: { reason: 'drawdown_limit', at: 2000 }, liveRiskStop: { reason: 'drawdown_limit', at: 2000 },
        reconciliationFaults: {}, entryHolds: {}, completed: [{ traded: true, pnl: -8, fees: 0, gas: 0 }],
        ...options.state });
    old.save();
    let requests = 0, financialWrites = 0;
    const forbidden = () => { financialWrites++; throw new Error('financial_write_forbidden'); };
    const provider = { send: async (method, args) => {
        if (method === 'eth_getTransactionCount') return args[1] === 'pending' ? options.pendingNonce || '0x2' : '0x2';
        if (method === 'eth_call') return safeNonce(args[1] === 'pending' ? options.pendingSafeNonce ?? 3 : 3);
        if (method === 'eth_getBlockByNumber') return { hash: options.blockHash || blockHash };
        throw new Error('unexpected_rpc');
    } };
    const client = {
        startBtcFeed() {}, serverTime: async () => { requests++; return Date.now(); }, json: async () => ({ blocked: false }),
        market: async () => ({ slug: 'market', conditionId: 'condition', minimum: 5, accepting: true,
            tick: .01, fee: { rate: .07, exponent: 1 } }),
        books: async () => [{ asks: [{ price: .8 }] }, { asks: [{ price: .2 }] }],
        walletHealth: async () => ({ contract: true, signerIsOwner: true, threshold: 1, balance: options.balance ?? 12,
            nativeGas: options.gas ?? 5, exchangeAllowance: 100, exchangeApproval: true, adapterApproval: true }),
        positions: async () => options.positions ?? [],
        ordersAndTrades: async () => ({ orders: options.orders ?? [], trades: options.trades ?? [] }),
        gasPriceUsd: async () => 1,
        confirmedBlock: async () => 123,
        rpc: { anchor: { number: 123, hash: blockHash }, read: async (_stage, task, block) => {
            assert.equal(block, 123); return task(provider, block);
        } },
        balance: async block => { assert.equal(block, 123); return options.proofBalance ?? options.balance ?? 12; },
        prepare: forbidden, post: forbidden, prepareAction: forbidden, broadcastAction: forbidden,
        prepareProfitTransfer: forbidden, cancel: forbidden,
    };
    const providers = { preflight: async () => ({ eligible: { ready: options.providerReady ?? true } }), predict: forbidden };
    const deps = { client, providers, clock: () => 3000 };
    const active = path.join(dataDir, 'eligible-risk-periods', runtimeId, 'active.json');
    return { config, old, client, providers, deps, dataDir, active,
        get requests() { return requests; }, get financialWrites() { return financialWrites; } };
}

test('manual period archives exact history and prepares a separate identity without funding or financial writes', async t => {
    const f = fixture(t), before = fs.readFileSync(f.old.filename);
    const result = await createRiskPeriod(f.config, f.deps);
    assert.equal(result.created, true); assert.equal(result.openingBalance, 12); assert.equal(result.drawdownStop, 10);
    assert.equal(result.automaticActivation, false); assert.equal(result.runtimeId, runtimeId);
    assert.notEqual(result.id, priorId); assert.notEqual(result.id, runtimeId);
    assert.deepEqual(fs.readFileSync(f.old.filename), before);
    assert.equal(fs.existsSync(path.join(f.dataDir, result.id)), false);
    const backup = path.join(path.dirname(f.active), result.id, 'backups', priorId, 'late-entry.json');
    assert.deepEqual(fs.readFileSync(backup), before);
    const bound = bindRiskPeriod(f.config), history = eligibleHistory(bound);
    assert.equal(bound.id, result.id); assert.equal(bound.settings.fingerprint, result.id);
    assert.equal(bound.ai.id, result.id); assert.equal(bound.ai.control, bound.settings);
    assert.equal(Object.isFrozen(bound.riskPeriod.approvedHistory), true);
    const readiness = eligibleReadiness({ config: bound, history, operationalReady: true });
    assert.equal(readiness.readyForLive, true);
    const previous = previousLiveSummary(bound, history);
    assert.equal(previous.periods[0].riskAcknowledged, true);
    assert.equal(previous.periods[0].maxDrawdown, 11); assert.equal(previous.periods[0].stopped.reason, 'drawdown_limit');
    const checked = await eligiblePreflight(bound, f.client, f.providers);
    assert.equal(checked.output.readyForLive, true);
    assert.equal(f.financialWrites, 0); assert.equal(fs.existsSync(path.join(f.dataDir, result.id)), false);
    await assert.rejects(createRiskPeriod(bound, f.deps), /already_prepared/);
});

test('later manual funding uses current wallet balance while a new drawdown remains persistent', async t => {
    const f = fixture(t);
    await createRiskPeriod(f.config, f.deps);
    const bound = bindRiskPeriod(f.config), store = new Store(bound.settings, 'pilot', 'late-entry');
    store.state.decisionProvider = 'eligible';
    allocateLiveCapital(store.state, bound, 12, { fresh: true, now: 4000 });
    assert.equal(store.state.cash, 12); assert.equal(store.state.peakEquity, 12); assert.equal(store.state.maxDrawdown, 0);
    assert.equal(bound.settings.drawdownStop, 10);
    Object.assign(store.state, { startedAt: 4000, maxDrawdown: 10.25, stopped: { reason: 'drawdown_limit', at: 5000 },
        liveRiskStop: { reason: 'drawdown_limit', at: 5000 } });
    store.save();
    const original = fs.readFileSync(store.filename), history = eligibleHistory(bound);
    const blocked = eligibleReadiness({ config: bound, history, operationalReady: true });
    assert.equal(blocked.readyForLive, false); assert.ok(blocked.blockers.includes('persistent_live_drawdown_stop'));
    assert.equal(eligibleReadiness({ config: bound, history, state: { ...store.state, stopped: null, liveRiskStop: null,
        maxDrawdown: 0 }, operationalReady: true }).readyForLive, false);
    const next = await createRiskPeriod(bound, { ...f.deps, clock: () => 6000 });
    assert.notEqual(next.id, bound.id); assert.equal(next.previousLive.periods.length, 2);
    assert.deepEqual(fs.readFileSync(store.filename), original);
    assert.equal(eligibleReadiness({ config: bindRiskPeriod(f.config),
        history: eligibleHistory(bindRiskPeriod(f.config)), operationalReady: true }).readyForLive, true);
});

test('local inventory, all withdrawal stages, unresolved faults and non-risk stops refuse before account reads', async t => {
    const cases = [
        { position: { market: { slug: 'old' }, holdings: [0, 0], orders: [] } },
        ...['address_requested', 'address_unknown', 'address_ready', 'source_uncertain', 'in_transit'].map(stage => ({
            profitTakingControl: { schema: 1, policy: {}, operation: { id: 'one', stage, createdAt: 1 } } })),
        { reconciliationFaults: { unknown: {} } }, { entryHolds: { feed: {} } },
        { stopped: { reason: 'wallet_ledger_mismatch', at: 2000 } },
        { completed: [{ traded: true, pnl: -8, fees: 0, gas: 0, uncertain: true }] },
    ];
    for (const state of cases) await t.test(JSON.stringify(state), async t => {
        const f = fixture(t, { state }), before = fs.readFileSync(f.old.filename);
        await assert.rejects(createRiskPeriod(f.config, f.deps));
        assert.equal(f.requests, 0); assert.equal(f.financialWrites, 0); assert.equal(fs.existsSync(f.active), false);
        assert.deepEqual(fs.readFileSync(f.old.filename), before);
    });
});

test('operational failures, open exposure, pending trades and EOA/Safe nonces refuse transition', async t => {
    const cases = [{ gas: 0 }, { providerReady: false }, { positions: [{ size: 1 }] },
        { positions: [{ size: null }] }, { orders: [{ id: 'unowned', conditionId: 'condition' }] },
        ...['MATCHED', 'MINED', 'RETRYING', 'unknown'].map(status => ({ trades: [{ status }] })),
        { pendingNonce: '0x3' }, { pendingSafeNonce: 4 }, { balance: 13 }, { proofBalance: 13 },
        { blockHash: `0x${'c'.repeat(64)}` }];
    for (const options of cases) await t.test(JSON.stringify(options), async t => {
        const f = fixture(t, options), before = fs.readFileSync(f.old.filename);
        await assert.rejects(createRiskPeriod(f.config, f.deps));
        assert.equal(fs.existsSync(f.active), false); assert.equal(f.financialWrites, 0);
        assert.deepEqual(fs.readFileSync(f.old.filename), before);
    });
    const f = fixture(t, { trades: [{ status: 'CONFIRMED' }, { status: 'FAILED' }], positions: [{ size: 0 }] });
    assert.equal((await createRiskPeriod(f.config, f.deps)).created, true);
});

test('active ledger snapshots stay internally consistent while the service atomically updates the file', async t => {
    const f = fixture(t); await createRiskPeriod(f.config, f.deps);
    const bound = bindRiskPeriod(f.config), active = new Store(bound.settings, 'pilot', 'late-entry');
    Object.assign(active.state, { decisionProvider: 'eligible', walletStart: 12, walletCashDelta: 0, cash: 12 });
    active.save();
    const archived = fs.readFileSync(f.old.filename), originalRead = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function (filename, ...args) {
        const bytes = originalRead.call(this, filename, ...args);
        if (filename === active.filename) {
            reads++;
            active.state.events++; active.state.cash--;
            atomicJson(active.filename, active.state);
        }
        return bytes;
    });
    const history = eligibleHistory(bound), own = history.find(state => state.baseline === bound.id);
    assert.equal(reads, 1, 'Parse and digest must use the very same read');
    assert.equal(own.cash, 12); assert.equal(own.events, 0);
    const snapshot = structuredClone(history);
    assert.equal(previousLiveSummary(bound, history).periods[0].riskAcknowledged, true);
    assert.equal(eligibleReadiness({ config: bound, history, operationalReady: true }).readyForLive, true);
    assert.deepEqual(history, snapshot, 'Validation cannot mix newer active state into an old snapshot');
    assert.deepEqual(fs.readFileSync(f.old.filename), archived);
    assert.equal(f.financialWrites, 0);
});

test('a changing active ledger never exempts archive pins, identity, presence or malformed data', async t => {
    for (const mutation of ['old-bytes', 'archive', 'omitted-active', 'edited-snapshot', 'untracked-snapshot',
        'active-identity', 'active-malformed'])
        await t.test(mutation, async t => {
            const f = fixture(t); await createRiskPeriod(f.config, f.deps);
            const bound = bindRiskPeriod(f.config), active = new Store(bound.settings, 'pilot', 'late-entry');
            active.state.decisionProvider = 'eligible'; active.save();
            const history = eligibleHistory(bound);
            active.state.events++; active.save();
            if (mutation === 'old-bytes') fs.appendFileSync(f.old.filename, '\n');
            if (mutation === 'archive') {
                const backup = path.join(path.dirname(f.active), bound.id, 'backups', priorId, 'late-entry.json');
                fs.chmodSync(backup, 0o600); fs.appendFileSync(backup, '\n');
            }
            if (mutation === 'active-identity') { active.state.baseline = priorId; active.save(); }
            if (mutation === 'active-malformed') fs.writeFileSync(active.filename, '{');
            if (mutation === 'edited-snapshot') history.find(state => state.baseline === bound.id).cash++;
            const supplied = mutation === 'omitted-active' ? history.filter(state => state.baseline !== bound.id)
                : mutation === 'untracked-snapshot' ? structuredClone(history) : history;
            assert.throws(() => validateRiskPeriodHistory(bound, supplied), /history_changed|archive_changed|identity mismatch|Cannot read/);
        });
});

test('missing, changed, extra or omitted history cannot inherit an acknowledgment', async t => {
    for (const mutation of ['changed', 'missing', 'extra', 'omitted', 'archive']) await t.test(mutation, async t => {
        const f = fixture(t); await createRiskPeriod(f.config, f.deps);
        const bound = bindRiskPeriod(f.config), history = eligibleHistory(bound);
        if (mutation === 'changed') fs.appendFileSync(f.old.filename, '\n');
        if (mutation === 'missing') fs.renameSync(f.old.filename, `${f.old.filename}.old`);
        if (mutation === 'extra') {
            const other = new Store({ ...f.config.settings, fingerprint: 'extra', capital: 20 }, 'pilot', 'late-entry');
            other.save();
        }
        if (mutation === 'archive') {
            const backup = path.join(path.dirname(f.active), bound.id, 'backups', priorId, 'late-entry.json');
            fs.chmodSync(backup, 0o600); fs.appendFileSync(backup, '\n');
        }
        assert.throws(() => validateRiskPeriodHistory(bound, mutation === 'omitted' ? [] : history), /history|archive/);
    });
});

test('wallet, policy, runtime, active pointer and record changes fail closed', async t => {
    const f = fixture(t); await createRiskPeriod(f.config, f.deps);
    const bound = bindRiskPeriod(f.config);
    assert.throws(() => bindRiskPeriod({ ...f.config, settings: { ...f.config.settings, wallet: `0x${'c'.repeat(40)}` } }), /mismatch/);
    assert.throws(() => bindRiskPeriod({ ...f.config, policy: { ...f.config.policy, changed: true } }), /mismatch/);
    assert.throws(() => bindRiskPeriod({ ...bound, runtimeId: '1122334455667788' }), /missing_pointer/);
    const valueFile = path.join(path.dirname(f.active), bound.id, 'record.json');
    const value = JSON.parse(fs.readFileSync(valueFile)); value.openingBalance = 100;
    fs.chmodSync(valueFile, 0o600); fs.writeFileSync(valueFile, JSON.stringify(value));
    assert.throws(() => bindRiskPeriod(f.config), /mismatch/);
});

test('shared lock and snapshot rechecks reject concurrent changes', async t => {
    const f = fixture(t), unlock = await acquireLock(f.dataDir, 'pilot');
    try { await assert.rejects(createRiskPeriod(f.config, f.deps), /already running/); }
    finally { await unlock(); }
    assert.equal(f.requests, 0); assert.equal(fs.existsSync(f.active), false);
    f.client.balance = async () => { fs.appendFileSync(f.old.filename, '\n'); return 12; };
    await assert.rejects(createRiskPeriod(f.config, f.deps), /history_changed/);
    assert.equal(fs.existsSync(f.active), false);
    const g = fixture(t);
    g.client.balance = async () => { atomicJson(g.active, { schema: 1, recordId: '1122334455667788' }); return 12; };
    await assert.rejects(createRiskPeriod(g.config, g.deps), /active_changed/);
});

test('nonce proof performs only fixed read RPCs and verifies its confirmed anchor', async t => {
    const f = fixture(t), calls = [];
    const read = f.client.rpc.read;
    f.client.rpc.read = (stage, task, block) => read(stage, provider => task({ send: (method, args) => {
        calls.push(method); return provider.send(method, args);
    } }), block);
    const proof = await readPeriodWalletProof(f.config, f.client);
    assert.equal(proof.balance, 12); assert.equal(proof.confirmedNonce, proof.pendingNonce);
    assert.deepEqual(calls.sort(), ['eth_call', 'eth_call', 'eth_getBlockByNumber',
        'eth_getTransactionCount', 'eth_getTransactionCount'].sort());
    f.client.rpc.anchor.hash = 'invalid';
    await assert.rejects(readPeriodWalletProof(f.config, f.client), /invalid_snapshot/);
    assert.equal(f.financialWrites, 0);
});

test('fresh startup rechecks exposure and pending transactions after manual preparation', async t => {
    for (const change of ['inventory', 'trade', 'nonce', 'balance']) await t.test(change, async t => {
        const f = fixture(t);
        await createRiskPeriod(f.config, f.deps);
        const config = bindRiskPeriod(f.config), pointer = fs.readFileSync(f.active);
        if (change === 'inventory') f.client.positions = async () => [{ size: 1 }];
        if (change === 'trade') f.client.ordersAndTrades = async () => ({ orders: [], trades: [{ status: 'MINED' }] });
        if (change === 'nonce') f.client.rpc.read = async () => { throw new Error('eligible_period_transactions_pending'); };
        if (change === 'balance') f.client.balance = async () => 13;
        const result = await eligiblePreflight(config, f.client, f.providers);
        assert.equal(result.output.readyForLive, false);
        assert.equal(result.output.checks.find(check => check.name === 'new_period_wallet_readiness').ok, false);
        assert.deepEqual(fs.readFileSync(f.active), pointer);
        assert.equal(fs.existsSync(path.join(f.dataDir, config.id, 'pilot/late-entry.json')), false);
        assert.equal(f.financialWrites, 0);
    });
});

test('fresh funding reports a consistent latest wallet snapshot rather than the preparation balance', async t => {
    const f = fixture(t); await createRiskPeriod(f.config, f.deps);
    const config = bindRiskPeriod(f.config), health = f.client.walletHealth;
    f.client.walletHealth = async () => ({ ...await health(), balance: 13 });
    f.client.balance = async () => 13;
    const result = await eligiblePreflight(config, f.client, f.providers);
    assert.equal(config.riskPeriod.openingBalance, 12);
    assert.equal(result.output.readyForLive, true);
    assert.equal(result.output.allocatedCapital, 13);
    assert.equal(f.financialWrites, 0);
});

test('historical maker receipts are archived at preparation and re-proven before fresh startup', async t => {
    const hash = `0x${'d'.repeat(64)}`, orderId = `0x${'e'.repeat(64)}`, condition = `0x${'f'.repeat(64)}`;
    const trade = { id: 'old-maker', status: 'MATCHED', traderSide: 'MAKER', conditionId: condition,
        assetId: '11', transactionHash: hash, makerOrders: [{ orderId, makerAddress: wallet,
            assetId: '22', tokenId: '22', side: 'BUY', matchedAmount: '5', price: '0.03' }] };
    const f = fixture(t, { trades: [trade] }), before = fs.readFileSync(f.old.filename);
    const ctf = new ethers.utils.Interface([
        'function getOutcomeSlotCount(bytes32) view returns (uint256)',
        'function getCollectionId(bytes32,bytes32,uint256) view returns (bytes32)',
        'function getPositionId(address,bytes32) view returns (uint256)',
    ]);
    const read = f.client.rpc.read;
    f.client.rpc.read = (stage, task, block) => stage === 'eligible_period_market' ? task({
        _isProvider: true, resolveName: async name => name,
        call: async (tx, tag) => {
            assert.equal(tx.to.toLowerCase(), CONTRACTS.conditionalTokens.toLowerCase());
            assert.equal(tag, 123);
            const { name, args } = ctf.parseTransaction(tx);
            const value = name === 'getOutcomeSlotCount' ? 2 : name === 'getCollectionId'
                ? ethers.utils.hexZeroPad(args[2].toHexString(), 32) : Number(BigInt(args[1])) * 11;
            return ctf.encodeFunctionResult(name, [value]);
        },
    }) : read(stage, task, block);
    const exchange = new ethers.utils.Interface([
        'event OrderFilled(bytes32 indexed orderHash,address indexed maker,address indexed taker,uint256 makerAssetId,uint256 takerAssetId,uint256 makerAmountFilled,uint256 takerAmountFilled,uint256 fee)',
    ]);
    const event = exchange.encodeEventLog(exchange.getEvent('OrderFilled'),
        [orderId, wallet, `0x${'c'.repeat(40)}`, 0, 22, 150000, 5000000, 0]);
    let receipts = 0;
    f.client.verifiedReceipt = async (transactionHash, block) => {
        receipts++; assert.equal(transactionHash, hash); assert.equal(block, 123);
        return { transactionHash, status: 1, blockNumber: 100, blockHash, confirmations: 24,
            logs: [{ address: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', logIndex: 1, ...event }] };
    };
    f.client.payoutAtBlock = async () => [1, 0];
    f.client.holdings = async (tokens, block) => { assert.deepEqual(tokens, ['11', '22']); assert.equal(block, 123); return [0, 0]; };
    const result = await createRiskPeriod(f.config, f.deps), config = bindRiskPeriod(f.config);
    assert.equal(result.tradeReadiness.receiptConfirmed.length, 1);
    assert.equal(config.riskPeriod.proof.trades.receiptConfirmed[0].orders[0].tokenId, '22');
    assert.equal(receipts, 1);
    const ready = await eligiblePreflight(config, f.client, f.providers);
    assert.equal(ready.output.readyForLive, true); assert.equal(receipts, 2);
    f.client.verifiedReceipt = async () => null;
    const blocked = await eligiblePreflight(config, f.client, f.providers);
    assert.equal(blocked.output.readyForLive, false);
    assert.equal(blocked.output.checks.find(check => check.name === 'new_period_wallet_readiness').error.code,
        'eligible_period_trades_pending');
    assert.deepEqual(fs.readFileSync(f.old.filename), before);
    assert.equal(f.financialWrites, 0);
    assert.equal(fs.existsSync(path.join(f.dataDir, config.id, 'pilot/late-entry.json')), false);
});
