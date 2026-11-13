import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { eligibleHistory, eligiblePreflight } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const empty = value => value == null || record(value) && Object.keys(value).length === 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const fail = () => { throw new Error('eligible_entry_cost_cap_migration_unproven'); };
const reviews = new WeakMap();
const reason = 'user_entry_cost_cap';
const proofLifetimeMs = 30000;

// Pin every accounting/authorization field, including unknown future fields.
// Only read diagnostics may advance between private review and taking the lock.
export function entryCostCapMigrationStateDigest(state) {
    if (!record(state)) fail();
    const { events, operational, diagnostics, failures, dataGaps, liveClock,
        lastTickAt, lastHeartbeatAt, ...selected } = state;
    if (record(selected.profitTakingControl)) {
        const { lastCheck, ...control } = selected.profitTakingControl;
        selected.profitTakingControl = control;
    }
    return digest(selected);
}

function checkedDirectory(root, parts) {
    if (!path.isAbsolute(root) || !fs.lstatSync(root).isDirectory()) fail();
    let directory = root;
    for (const part of parts) {
        directory = path.join(directory, part);
        if (!fs.lstatSync(directory).isDirectory()) fail();
    }
    return directory;
}

function previousManifest(config, migration) {
    const directory = checkedDirectory(config.settings.dataDir,
        [config.id, 'eligible-runtime', 'revisions', migration.previousRuntimeId]);
    const filename = path.join(directory, 'manifest.json');
    if (!fs.lstatSync(filename).isFile()) fail();
    const bytes = fs.readFileSync(filename);
    if (hash(bytes) !== migration.previousManifestSha256) fail();
    const manifest = JSON.parse(bytes), { entryFilter, ...previousPolicy } = config.policy;
    if (manifest.id !== config.id || manifest.runtimeId !== migration.previousRuntimeId
        || manifest.startedAt !== config.runtimeContinuation.ledgerStartedAt
        || !isDeepStrictEqual(manifest.policy, previousPolicy)
        || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
        || !Array.isArray(manifest.sources) || !manifest.sources.length
        || manifest.sources.some(source => !Array.isArray(source) || source.length !== 2
            || typeof source[0] !== 'string' || !source[0] || path.posix.isAbsolute(source[0])
            || source[0].split('/').some(part => ['', '.', '..'].includes(part)) || !HASH.test(source[1]))
        || new Set(manifest.sources.map(source => source[0])).size !== manifest.sources.length
        || digest({ policy: manifest.policy, sources: manifest.sources,
            profitTaking: manifest.profitTaking }).slice(0, 16) !== migration.previousRuntimeId) fail();
}

function candidate(config, state, now) {
    const approval = config.runtimeContinuation, migration = approval?.entryCostCapMigration;
    const { continuousTrading, entryFilter, ...originalPolicy } = config.policy || {};
    const filter = { version: 'full-fill-all-in-cost-cap-v1', maxCostPerShare: 0.85,
        gasUsd: originalPolicy.execution?.gasUsd, basis: 'full_fill_at_frozen_limit' };
    if (approval?.reason !== reason || !record(migration)
        || config.settings.continuousTrading !== true || continuousTrading !== true
        || config.policy.provider !== 'eligible' || !Number.isFinite(filter.gasUsd) || filter.gasUsd < 0
        || !isDeepStrictEqual(entryFilter, filter)
        || approval.policyChange?.previousPolicySha256 !== digest(originalPolicy)
        || approval.policyChange?.currentPolicySha256 !== digest(config.policy)
        || !ID.test(config.runtimeId) || approval.runtimeId !== config.runtimeId
        || !ID.test(approval.originalRuntimeId) || config.riskRuntimeId !== approval.originalRuntimeId
        || config.riskPeriod?.runtimeId !== approval.originalRuntimeId
        || approval.periodId !== config.id || config.riskPeriod?.periodId !== config.id
        || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.stateSha256)
        || state?.baseline !== config.id || state.mode !== 'pilot' || state.strategy !== 'late-entry'
        || state.decisionProvider !== 'eligible' || !timestamp(state.startedAt)
        || state.startedAt !== approval.ledgerStartedAt || !timestamp(now) || now < state.startedAt
        || digest(state.liveFunding) !== approval.fundingSha256
        || entryCostCapMigrationStateDigest(state) !== migration.stateSha256
        || !record(state.continuousOperation) || !isDeepStrictEqual(state.continuousOperation, migration.continuousOperation)
        || state.continuousOperation.runtimeId !== migration.previousRuntimeId
        || !timestamp(state.continuousOperation.enabledAt) || state.continuousOperation.enabledAt < state.startedAt
        || state.continuousOperation.enabledAt > now
        || state.position != null || state.stopped != null || state.liveRiskStop != null || state.frozenAt != null
        || !empty(state.entryHolds) || !empty(state.reconciliationFaults)
        || state.profitTaking?.pending != null || state.profitTakingControl?.operation != null
        || state.liveClock != null && (!record(state.liveClock) || !['verified', 'waiting'].includes(state.liveClock.status))
        || !Number.isFinite(state.cash) || !Number.isFinite(state.peakEquity)
        || !Number.isFinite(state.maxDrawdown) || state.maxDrawdown < 0
        || !record(state.liveFunding) || !Number.isFinite(state.liveFunding.initialCapital)
        || state.liveFunding.initialCapital < 0 || !Number.isFinite(state.walletStart) || !Number.isFinite(state.walletCashDelta)
        || !record(state.seen) || !record(state.ai) || !record(state.ai.providers)
        || Object.entries(state.ai.providers).some(([name, provider]) =>
            name !== 'eligible' || !record(provider) || provider.pending || provider.disabled)
        || !Array.isArray(state.ai.snapshots) || !record(state.ai.slots) || !Array.isArray(state.completed)
        || state.completed.some(row => !record(row) || row.uncertain || row.pendingTrades
            || !Number.isFinite(row.pnl) || !timestamp(row.closedAt) || row.closedAt > now
            || !Array.isArray(row.tokens) || row.tokens.length !== 2 || row.tokens[0] === row.tokens[1]
            || row.tokens.some(token => typeof token !== 'string' || !/^[1-9]\d*$/.test(token))
            || row.actions != null && (!Array.isArray(row.actions)
                || row.actions.some(action => !record(action) || !['confirmed', 'failed'].includes(action.status)))
            || row.orders != null && (!Array.isArray(row.orders)
                || row.orders.some(order => !record(order) || !['complete', 'rejected', 'cancelled'].includes(order.status))))
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)
        || state.strategyEpochs != null && (!Array.isArray(state.strategyEpochs) || state.strategyEpochs.length > 0)
        || state.currentStrategyEpochId != null) fail();
    previousManifest(config, migration);
    return migration;
}

// The caller holds the pilot flock for both preparation and apply. No transaction
// builders, cancellations, withdrawals, or inference are admitted by this path.
export async function prepareEntryCostCapMigration(config, state, client, providers, { now = Date.now } = {}) {
    const migration = candidate(config, state, now()), beforeSha256 = digest(state), configSha256 = digest(config);
    const guard = () => {
        if (digest(state) !== beforeSha256 || digest(config) !== configSha256) fail();
        candidate(config, state, now());
    };
    const history = () => {
        guard();
        const rows = eligibleHistory(config);
        if (!isDeepStrictEqual(rows.find(row => row.baseline === config.id && row.strategy === 'late-entry'), state)) fail();
        return rows;
    };
    const checked = await eligiblePreflight(config, client, providers, state,
        { history: history(), refreshHistory: history });
    guard();
    if (checked.output.operationalReady !== true || checked.output.readyForLive !== true
        || checked.output.startAllowed !== true || checked.output.recoveryOnly !== false
        || !isDeepStrictEqual(checked.output.blockers, [])) fail();
    const proof = await readPeriodWalletProof(config, client);
    guard();
    let trades = await assertPeriodAccountReady(checked.account, { client, wallet: config.settings.wallet, proof });
    guard();
    const holdings = [];
    for (const completed of state.completed) {
        const amounts = await client.holdings(completed.tokens, proof.blockNumber);
        guard();
        if (!Array.isArray(amounts) || amounts.length !== 2 || amounts.some(amount => amount !== 0)) fail();
        holdings.push({ conditionId: completed.conditionId, tokens: [...completed.tokens], amounts });
    }
    const [latest, positions] = await Promise.all([client.ordersAndTrades(), client.positions()]);
    guard();
    if (!record(latest) || !Array.isArray(latest.orders)) fail();
    trades = await assertPeriodAccountReady({ ...checked.account, positions, openOrders: latest.orders,
        checks: [{ name: 'authenticated_order_trade_api', detail: { trades: latest.trades } }] },
    { client, wallet: config.settings.wallet, proof });
    guard();
    if (client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash) fail();
    const verifiedAt = now(), finalProof = await readPeriodWalletProof(config, client);
    guard();
    if (!timestamp(verifiedAt) || !timestamp(now()) || now() < verifiedAt || now() - verifiedAt > proofLifetimeMs
        || finalProof.blockNumber < proof.blockNumber
        || finalProof.blockNumber === proof.blockNumber && finalProof.blockHash !== proof.blockHash
        || ['confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce', 'balance'].some(key => finalProof[key] !== proof[key])) fail();
    const expected = expectedWalletBalance(state);
    if (!Number.isFinite(expected) || Math.abs(proof.balance - expected) > EPS
        || !Number.isFinite(checked.account.wallet?.balance) || Math.abs(checked.account.wallet.balance - proof.balance) > EPS
        || client.rpc.anchor?.number !== finalProof.blockNumber || client.rpc.anchor?.hash !== finalProof.blockHash) fail();
    history();
    const startedAt = now(), expiresAt = verifiedAt + proofLifetimeMs, nextState = structuredClone(state);
    if (!timestamp(startedAt) || startedAt < verifiedAt || startedAt > expiresAt) fail();
    const identity = { periodId: config.id, runtimeId: config.runtimeId, startedAt,
        firstCompletedIndex: state.completed.length, firstSnapshotIndex: state.ai.snapshots.length };
    const epoch = { id: digest(identity).slice(0, 16), startedAt, policy: structuredClone(config.policy),
        runtimeId: config.runtimeId, firstCompletedIndex: identity.firstCompletedIndex,
        firstSnapshotIndex: identity.firstSnapshotIndex, cashAtStart: state.cash,
        previousRuntimeId: migration.previousRuntimeId, reason, beforeSha256,
        walletProof: { ...finalProof, verifiedAt, expectedBalance: expected, trades,
            holdingsProof: { blockNumber: proof.blockNumber, blockHash: proof.blockHash, holdings } } };
    nextState.strategyEpochs = [...(state.strategyEpochs || []), epoch];
    nextState.currentStrategyEpochId = epoch.id;
    nextState.continuousOperationHistory = [...(state.continuousOperationHistory || []),
        { ...state.continuousOperation, migratedAt: startedAt, nextRuntimeId: config.runtimeId,
            previousManifestSha256: migration.previousManifestSha256, reasonVerified: reason, beforeSha256 }];
    nextState.continuousOperation.runtimeId = config.runtimeId;
    const summary = { ready: true, reason, periodId: config.id, runtimeId: config.runtimeId,
        previousRuntimeId: migration.previousRuntimeId, strategyEpochId: epoch.id,
        blockNumber: finalProof.blockNumber, blockHash: finalProof.blockHash, verifiedAt, expiresAt,
        walletPUSD: finalProof.balance, expectedWalletPUSD: expected, cash: state.cash,
        peakEquity: state.peakEquity, maxDrawdown: state.maxDrawdown, completedMarkets: state.completed.length,
        filledMarkets: state.completed.filter(row => row.traded).length,
        accountingPreserved: true, riskPeriodPreserved: true, financialWrites: false };
    const review = { summary, nextState, beforeSha256 };
    reviews.set(review, { config, state, beforeSha256, nextSha256: digest(nextState), summarySha256: digest(summary),
        verifiedAt, expiresAt, now, history });
    return review;
}

function archiveLedger(store, config) {
    const directory = checkedDirectory(config.settings.dataDir, [config.id, 'pilot']);
    if (store.filename !== path.join(directory, 'late-entry.json') || !fs.lstatSync(store.filename).isFile()) fail();
    const bytes = fs.readFileSync(store.filename);
    if (!isDeepStrictEqual(JSON.parse(bytes), store.state)) fail();
    const archiveSha256 = hash(bytes), root = checkedDirectory(config.settings.dataDir, [config.id, 'eligible-runtime']);
    const archiveDirectory = path.join(root, 'entry-cost-cap-migration');
    try { fs.mkdirSync(archiveDirectory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(archiveDirectory).isDirectory()) fail();
    const archivePath = path.join(archiveDirectory, `${archiveSha256}.json`);
    let fd;
    try {
        fd = fs.openSync(archivePath, 'wx', 0o400);
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } catch (error) {
        if (error.code !== 'EEXIST' || !fs.lstatSync(archivePath).isFile()
            || !fs.readFileSync(archivePath).equals(bytes)) throw error;
        fd = fs.openSync(archivePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        fs.fsyncSync(fd);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    for (const target of [archiveDirectory, root]) {
        const dir = fs.openSync(target, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
    return { archivePath, archiveSha256 };
}

export function applyEntryCostCapMigration(store, review, { explicitApply = false } = {}) {
    const prepared = reviews.get(review);
    if (!explicitApply || !prepared || store.state !== prepared.state || review.summary?.ready !== true
        || review.beforeSha256 !== prepared.beforeSha256 || digest(store.state) !== prepared.beforeSha256
        || digest(review.nextState) !== prepared.nextSha256 || digest(review.summary) !== prepared.summarySha256) fail();
    const fresh = () => {
        prepared.history();
        const at = prepared.now();
        if (!timestamp(at) || at < prepared.verifiedAt || at > prepared.expiresAt) fail();
    };
    fresh();
    const archived = archiveLedger(store, prepared.config);
    fresh();
    const keys = ['strategyEpochs', 'currentStrategyEpochId', 'continuousOperation', 'continuousOperationHistory'];
    const previous = new Map(keys.map(key => [key, { exists: Object.hasOwn(store.state, key), value: store.state[key] }]));
    for (const key of keys) store.state[key] = structuredClone(review.nextState[key]);
    try { store.save(); }
    catch (error) {
        for (const [key, old] of previous) {
            if (old.exists) store.state[key] = old.value;
            else delete store.state[key];
        }
        throw error;
    }
    reviews.delete(review);
    return { ...review.summary, ...archived };
}
