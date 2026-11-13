
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ethers } from 'ethers';
import { acquireLock as lockPilot, atomicJson } from '../restart/store.js';
import { EPS, round } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { reconcilePeriodTrades } from './period-trades.js';
import { ELIGIBLE_BUFFER_POLICY } from './entry-buffer.js';
import { continuationProfitTaking, verifiedEntryCostCapAdjustment } from './profit-policy-proof.js';

function pilotHistorySnapshots(settings) {
    if (!fs.existsSync(settings.dataDir)) return [];
    const found = [];
    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    for (const baseline of fs.readdirSync(settings.dataDir, { withFileTypes: true })) {
        if (!baseline.isDirectory()) continue;
        const dir = path.join(settings.dataDir, baseline.name, 'pilot');
        if (!fs.existsSync(dir)) continue;
        for (const strategy of ['late-entry', 'maker-mm']) {
            const filename = path.join(dir, `${strategy}.json`);
            if (!fs.existsSync(filename)) continue;
            let bytes, state;
            try { bytes = fs.readFileSync(filename); state = JSON.parse(bytes); }
            catch (error) { throw new Error(`Cannot read pilot ledger ${filename}: ${error.message}`, { cause: error }); }
            if (!isRecord(state)) throw new Error(`Pilot ledger is incomplete or corrupt: ${filename}`);
            if (state.baseline !== baseline.name || state.mode !== 'pilot' || state.strategy !== strategy)
                throw new Error(`Pilot ledger identity mismatch: ${filename}`);
            if (!Number.isFinite(state.cash) || !Number.isFinite(state.startedAt)
                || !Number.isFinite(state.peakEquity) || !Number.isFinite(state.maxDrawdown)
                || !Number.isFinite(state.failures) || !isRecord(state.seen) || !Array.isArray(state.completed)
                || state.completed.some(row => !isRecord(row) || row.traded
                    && ![row.pnl, row.fees, row.gas].every(Number.isFinite)))
                throw new Error(`Pilot ledger is incomplete or corrupt: ${filename}`);
            const position = state.position;
            if (position != null && (!isRecord(position) || !isRecord(position.market)
                || typeof position.market.slug !== 'string' || !Array.isArray(position.holdings)
                || position.holdings.length !== 2 || !position.holdings.every(Number.isFinite)
                || !Array.isArray(position.orders)
                || position.orders.some(order => !isRecord(order) || typeof order.status !== 'string')))
                throw new Error(`Pilot ledger position is incomplete or corrupt: ${filename}`);
            found.push({ state, bytes });
        }
    }
    return found;
}

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const BLOCK_HASH = /^0x[a-fA-F0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => digest(JSON.stringify(value));
// Only an unmodified snapshot captured by this reader may differ from a newer
// active file. Arbitrary caller-supplied or edited history keeps the old check.
const activeHistorySnapshots = new WeakMap();
const fail = code => { throw new Error(`eligible_period_${code}`); };
const identity = state => `${state.baseline}:${state.strategy}`;
const safe = new ethers.utils.Interface(['function nonce() view returns (uint256)']);

function locations(config) {
    const runtimeId = config.riskRuntimeId ?? config.runtimeId ?? config.id;
    if (!ID.test(runtimeId) || !path.isAbsolute(config.settings.dataDir)) fail('invalid_identity');
    const dataDir = fs.existsSync(config.settings.dataDir)
        ? fs.realpathSync(config.settings.dataDir) : path.resolve(config.settings.dataDir);
    const root = path.join(dataDir, 'eligible-risk-periods', runtimeId);
    for (const directory of [path.dirname(root), root]) {
        if (fs.existsSync(directory) && !fs.lstatSync(directory).isDirectory()) fail('unsafe_path');
    }
    return { runtimeId, dataDir, root, active: path.join(root, 'active.json') };
}

function readFile(filename, optional = false) {
    try {
        if (!fs.lstatSync(filename).isFile()) fail('unsafe_path');
        return fs.readFileSync(filename);
    } catch (error) {
        if (optional && error.code === 'ENOENT') return null;
        throw error;
    }
}

function parse(bytes) {
    try { const value = JSON.parse(bytes); if (!record(value)) fail('invalid_record'); return value; }
    catch { fail('invalid_record'); }
}

function deepFreeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
    return value;
}

function historySnapshot(config) {
    const { dataDir } = locations(config);
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir, { withFileTypes: true }).some(entry => entry.isSymbolicLink()))
        fail('unsafe_path');
    const rows = pilotHistorySnapshots(config.settings).map(({ state, bytes }) => {
        if (path.basename(state.baseline) !== state.baseline || ['.', '..'].includes(state.baseline)) fail('invalid_history_path');
        const directory = path.join(dataDir, state.baseline, 'pilot');
        for (const dir of [path.dirname(directory), directory]) {
            if (!fs.lstatSync(dir).isDirectory()) fail('unsafe_path');
        }
        const relative = path.posix.join(state.baseline, 'pilot', `${state.strategy}.json`);
        if (!fs.lstatSync(path.join(dataDir, relative)).isFile()) fail('unsafe_path');
        return { state, bytes, pin: { baseline: state.baseline, strategy: state.strategy,
            path: relative, sha256: digest(bytes) } };
    }).sort((a, b) => a.pin.path.localeCompare(b.pin.path));
    if (new Set(rows.map(row => identity(row.state))).size !== rows.length) fail('duplicate_history');
    return rows;
}

export function validateRiskPeriodRecord(config, value) {
    const location = locations(config), { periodId, ...payload } = value;
    const continuation = config.runtimeContinuation;
    let policySha256 = jsonHash(config.policy);
    // The active period retains the immutable policy pin that established it.
    if (continuation?.reason === 'user_continuous_trading' && continuation.periodId === periodId) {
        const { continuousTrading, ...previousPolicy } = config.policy;
        if (config.settings.continuousTrading !== true || continuousTrading !== true
            || continuation.policyChange?.currentPolicySha256 !== policySha256
            || continuation.policyChange?.previousPolicySha256 !== jsonHash(previousPolicy)) fail('record_mismatch');
        policySha256 = continuation.policyChange.previousPolicySha256;
    }
    if (['user_entry_cost_cap', 'user_return_cost_cap'].includes(continuation?.reason) && continuation.periodId === periodId) {
        const { continuousTrading, entryFilter, ...previousPolicy } = config.policy;
        const filter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.85,
            gasUsd: previousPolicy.execution?.gasUsd, basis: 'full_fill_at_frozen_limit' };
        if (config.settings.continuousTrading !== true || continuousTrading !== true
            || !Number.isFinite(filter.gasUsd) || filter.gasUsd < 0 || !isDeepStrictEqual(entryFilter, filter)
            || continuation.policyChange?.currentPolicySha256 !== policySha256
            || continuation.policyChange?.previousPolicySha256 !== jsonHash(previousPolicy)) fail('record_mismatch');
        policySha256 = continuation.policyChange.previousPolicySha256;
    }
    if (continuation?.reason === 'user_entry_buffer' && continuation.periodId === periodId) {
        const { continuousTrading, entryFilter, ...previousPolicy } = config.policy;
        if (config.settings.continuousTrading !== true || continuousTrading !== true
            || !isDeepStrictEqual(entryFilter, ELIGIBLE_BUFFER_POLICY)
            || !record(continuation.policyChange) || Object.keys(continuation.policyChange).length !== 2
            || continuation.policyChange.currentPolicySha256 !== policySha256
            || continuation.policyChange.previousPolicySha256 !== jsonHash(previousPolicy)) fail('record_mismatch');
        policySha256 = continuation.policyChange.previousPolicySha256;
    }
    if (continuation?.reason === 'user_entry_cost_cap_adjustment' && continuation.periodId === periodId) {
        const originalPolicySha256 = verifiedEntryCostCapAdjustment(config);
        const { continuousTrading, entryFilter, ...previousPolicy } = config.policy;
        const filter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.82,
            gasUsd: previousPolicy.execution?.gasUsd, basis: 'full_fill_at_frozen_limit' };
        if (config.settings.continuousTrading !== true || continuousTrading !== true
            || !Number.isFinite(filter.gasUsd) || filter.gasUsd < 0 || !isDeepStrictEqual(entryFilter, filter)
            || !record(continuation.policyChange) || Object.keys(continuation.policyChange).length !== 2
            || continuation.policyChange.currentPolicySha256 !== policySha256
            || originalPolicySha256 !== jsonHash(previousPolicy)) fail('record_mismatch');
        policySha256 = originalPolicySha256;
    }
    if (value.schema !== 1 || !ID.test(periodId) || jsonHash(payload).slice(0, 16) !== periodId
        || value.runtimeId !== location.runtimeId || value.dataDir !== location.dataDir
        || value.wallet !== config.settings.wallet?.toLowerCase()
        || !ethers.utils.isAddress(value.wallet) || value.drawdownStop !== 10
        || config.settings.drawdownStop !== 10 || value.policySha256 !== policySha256
        || value.profitTakingSha256 !== jsonHash(continuationProfitTaking(config, periodId) ?? null)
        || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !HASH.test(value.nonce)
        || !Number.isFinite(value.openingBalance) || value.openingBalance < 0
        || value.acknowledgment !== 'manual_new_risk_period' || value.automaticActivation !== false
        || !Array.isArray(value.approvedHistory) || !value.approvedHistory.length) fail('record_mismatch');
    const pins = value.approvedHistory;
    if (new Set(pins.map(identity)).size !== pins.length || pins.some(pin => !record(pin)
        || typeof pin.baseline !== 'string' || path.basename(pin.baseline) !== pin.baseline
        || ['.', '..', periodId].includes(pin.baseline) || !['late-entry', 'maker-mm'].includes(pin.strategy)
        || pin.path !== path.posix.join(pin.baseline, 'pilot', `${pin.strategy}.json`) || !HASH.test(pin.sha256)))
        fail('invalid_history_pins');
    return value;
}

function activeRecord(config) {
    const location = locations(config), pointer = readFile(location.active, true);
    if (!pointer) return { ...location, pointer, value: null };
    const selected = parse(pointer);
    if (selected.schema !== 1 || !ID.test(selected.recordId)) fail('invalid_pointer');
    const directory = path.join(location.root, selected.recordId);
    if (!fs.lstatSync(directory).isDirectory()) fail('unsafe_path');
    const value = validateRiskPeriodRecord(config, parse(readFile(path.join(directory, 'record.json'))));
    if (value.periodId !== selected.recordId) fail('record_mismatch');
    return { ...location, pointer, value };
}

export function bindRiskPeriod(config) {
    const { value } = activeRecord(config);
    if (!value) {
        if (config.riskPeriod || config.runtimeContinuation) fail('missing_pointer');
        return config;
    }
    const settings = { ...config.settings, fingerprint: value.periodId };
    return { ...config, runtimeId: config.runtimeId || config.id, id: value.periodId, settings,
        ai: { ...config.ai, id: value.periodId, control: settings }, riskPeriod: deepFreeze(value) };
}

export function validateRiskPeriodHistory(config, history) {
    if (!config.riskPeriod) return new Set();
    return validateHistorySnapshot(config, history, historySnapshot(config));
}

export function readRiskPeriodHistory(config) {
    const rows = historySnapshot(config), history = rows.map(row => row.state);
    if (config.riskPeriod) validateHistorySnapshot(config, history, rows);
    activeHistorySnapshots.set(history, { id: config.id,
        sha256: jsonHash(history.filter(state => state.baseline === config.id)) });
    return history;
}

function validateHistorySnapshot(config, history, rows) {
    const current = activeRecord(config);
    if (!current.value || config.id !== current.value.periodId
        || !isDeepStrictEqual(config.riskPeriod, current.value)) fail('active_changed');
    const captured = activeHistorySnapshots.get(history);
    const unchangedSnapshot = captured?.id === config.id
        && captured.sha256 === jsonHash(history.filter(state => state.baseline === config.id));
    if (!Array.isArray(history) || history.length !== rows.length
        || rows.some(row => {
            const supplied = history.find(state => identity(state) === identity(row.state));
            // The active ledger is deliberately NOT pinned: reports retain
            // their original consistent version while the service appends.
            // Identities, archived bytes and every approvedHistory pin still
            // have to match exactly on every subsequent validation.
            return !supplied || !(row.state.baseline === config.id && unchangedSnapshot)
                && !isDeepStrictEqual(row.state, supplied);
        }))
        fail('history_changed');
    const previous = rows.filter(row => row.state.baseline !== config.id);
    const pins = current.value.approvedHistory;
    if (previous.length !== pins.length || previous.some(row => !pins.some(pin => isDeepStrictEqual(pin, row.pin))))
        fail('history_changed');
    for (const pin of pins) {
        const directory = path.join(current.root, current.value.periodId, 'backups', pin.baseline);
        for (const dir of [path.dirname(directory), directory]) {
            if (!fs.lstatSync(dir).isDirectory()) fail('unsafe_path');
        }
        if (digest(readFile(path.join(directory, `${pin.strategy}.json`))) !== pin.sha256) fail('archive_changed');
    }
    return new Set(pins.map(identity));
}

function assertFlatHistory(history) {
    if (!history.length) fail('history_required');
    for (const state of history) {
        if (state.position != null) fail('inventory_open');
        if (state.profitTaking?.pending != null || state.profitTakingControl?.operation != null)
            fail('withdrawal_pending');
        for (const field of ['reconciliationFaults', 'entryHolds']) {
            if (state[field] != null && (!record(state[field]) || Object.keys(state[field]).length)) fail('unresolved_fault');
        }
        if (state.completed.some(row => row.uncertain || row.pendingTrades)) fail('unresolved_fault');
        if (Object.values(state.ai?.providers || {}).some(provider => provider?.pending)) fail('unresolved_fault');
        if ([state.stopped, state.liveRiskStop].some(stop => stop && stop.reason !== 'drawdown_limit'))
            fail('unresolved_stop');
    }
}

export async function readPeriodWalletProof(config, client) {
    const signer = new ethers.Wallet(config.settings.privateKey).address.toLowerCase();
    const block = await client.confirmedBlock(), anchor = client.rpc?.anchor;
    if (!Number.isSafeInteger(block) || block < 0 || anchor?.number !== block || !BLOCK_HASH.test(anchor.hash))
        fail('invalid_snapshot');
    const blockHash = anchor.hash, tag = ethers.utils.hexValue(block);
    const [nonces, balance] = await Promise.all([
        client.rpc.read('eligible_period_pending_transactions', async provider => {
            const [confirmed, pending, safeConfirmed, safePending] = await Promise.all([
                provider.send('eth_getTransactionCount', [signer, tag]),
                provider.send('eth_getTransactionCount', [signer, 'pending']),
                provider.send('eth_call', [{ to: config.settings.wallet, data: safe.encodeFunctionData('nonce') }, tag]),
                provider.send('eth_call', [{ to: config.settings.wallet, data: safe.encodeFunctionData('nonce') }, 'pending']),
            ]);
            const number = value => {
                if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) fail('invalid_nonce');
                return ethers.BigNumber.from(value).toString();
            };
            const proof = { confirmedNonce: number(confirmed), pendingNonce: number(pending),
                safeNonce: safe.decodeFunctionResult('nonce', safeConfirmed)[0].toString(),
                pendingSafeNonce: safe.decodeFunctionResult('nonce', safePending)[0].toString() };
            if (proof.confirmedNonce !== proof.pendingNonce || proof.safeNonce !== proof.pendingSafeNonce)
                fail('transactions_pending');
            const header = await provider.send('eth_getBlockByNumber', [tag, false]);
            if (header?.hash !== blockHash) fail('snapshot_changed');
            return proof;
        }, block),
        client.balance(block),
    ]);
    if (!Number.isFinite(balance) || balance < 0 || client.rpc.anchor?.number !== block
        || client.rpc.anchor?.hash !== blockHash) fail('invalid_snapshot');
    return { blockNumber: block, blockHash, signer, ...nonces, balance: round(balance) };
}

export async function assertPeriodAccountReady(account, context = {}) {
    if (!Array.isArray(account?.positions) || account.positions.some(position => !record(position) || position.size !== 0))
        fail('inventory_open');
    if (!Array.isArray(account.openOrders) || account.openOrders.length) fail('orders_open');
    const trades = account.checks?.find(check => check.name === 'authenticated_order_trade_api')?.detail?.trades;
    return reconcilePeriodTrades(trades, context);
}

function writeExclusive(filename, bytes) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(filename, 'wx', 0o400);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(path.dirname(filename), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

export async function createRiskPeriod(config, { client, providers, clock = Date.now, acquireLock = lockPilot } = {}) {
    const before = activeRecord(config);
    const release = await acquireLock(config.settings.dataDir, 'pilot');
    try {
        const selected = activeRecord(config);
        if (!isDeepStrictEqual(before.pointer, selected.pointer)) fail('active_changed');
        config = bindRiskPeriod(config);
        const { eligibleHistory, eligiblePreflight, previousLiveSummary } = await import('./preflight.js');
        const history = eligibleHistory(config), snapshots = historySnapshot(config);
        if (snapshots.length !== history.length || snapshots.some(row => !isDeepStrictEqual(row.state,
            history.find(state => identity(state) === identity(row.state))))) fail('history_changed');
        if (config.riskPeriod && !history.some(state => state.baseline === config.id)) fail('already_prepared');
        assertFlatHistory(history);
        const funded = history.filter(state => Number.isFinite(state.walletStart)).sort((a, b) => b.startedAt - a.startedAt);
        const latest = funded[0];
        if (!latest || funded[1]?.startedAt === latest.startedAt) fail('funding_history_ambiguous');
        if (config.riskPeriod && latest.baseline !== config.id) fail('funding_history_ambiguous');
        if (!(latest.maxDrawdown >= 10 - EPS || latest.stopped?.reason === 'drawdown_limit'
            || latest.liveRiskStop?.reason === 'drawdown_limit')) fail('drawdown_stop_required');
        const expectedBalance = expectedWalletBalance(latest);
        if (!Number.isFinite(expectedBalance) || expectedBalance < 0) fail('invalid_funding_history');
        const own = history.find(state => state.baseline === config.id) || null;
        const checked = await eligiblePreflight(config, client, providers, own, { history });
        const { output, account } = checked;
        if (output.operationalReady !== true || !Array.isArray(account.checks) || !account.checks.length
            || account.checks.some(check => check.ok !== true)) fail('operational_check_failed');
        const proof = await readPeriodWalletProof(config, client);
        proof.trades = await assertPeriodAccountReady(account, { client, wallet: config.settings.wallet, proof });
        if (!Number.isFinite(output.balance) || Math.abs(output.balance - proof.balance) > EPS
            || Math.abs(expectedBalance - proof.balance) > EPS) fail('wallet_ledger_mismatch');
        const createdAt = clock();
        if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('invalid_clock');
        const payload = { schema: 1, runtimeId: selected.runtimeId, wallet: config.settings.wallet.toLowerCase(),
            dataDir: selected.dataDir, priorPeriodId: latest.baseline, policySha256: jsonHash(config.policy),
            profitTakingSha256: jsonHash(config.profitTaking ?? null), createdAt, nonce: crypto.randomBytes(32).toString('hex'),
            acknowledgment: 'manual_new_risk_period', drawdownStop: 10, openingBalance: proof.balance,
            approvedHistory: snapshots.map(row => row.pin), proof, automaticActivation: false };
        const periodId = jsonHash(payload).slice(0, 16), value = { periodId, ...payload };
        validateRiskPeriodRecord(config, value);
        const previousLive = previousLiveSummary({ ...config, id: periodId, riskPeriod: null }, history);
        for (const period of previousLive.periods) period.riskAcknowledged = true;
        if (!isDeepStrictEqual(snapshots.map(row => row.pin), historySnapshot(config).map(row => row.pin))) fail('history_changed');
        if (!isDeepStrictEqual(selected.pointer, readFile(selected.active, true))) fail('active_changed');
        if (fs.existsSync(path.join(selected.dataDir, periodId))) fail('identity_collision');
        const directory = path.join(selected.root, periodId);
        fs.mkdirSync(selected.root, { recursive: true, mode: 0o700 });
        fs.mkdirSync(directory, { mode: 0o700 });
        for (const row of snapshots) writeExclusive(path.join(directory, 'backups', row.state.baseline,
            `${row.state.strategy}.json`), row.bytes);
        if (!isDeepStrictEqual(snapshots.map(row => row.pin), historySnapshot(config).map(row => row.pin))) fail('history_changed');
        if (!isDeepStrictEqual(selected.pointer, readFile(selected.active, true))) fail('active_changed');
        writeExclusive(path.join(directory, 'record.json'), JSON.stringify(value, null, 2));
        atomicJson(selected.active, { schema: 1, recordId: periodId });
        return { created: true, id: periodId, runtimeId: config.runtimeId || config.id, drawdownStop: 10,
            openingBalance: proof.balance, previousLive, tradeReadiness: proof.trades,
            automaticActivation: false };
    } finally { await release(); }
}
