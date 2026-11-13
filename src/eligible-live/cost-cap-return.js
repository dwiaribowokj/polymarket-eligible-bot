import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EPS } from '../restart/math.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { eligibleHistory, eligiblePreflight } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';
import { readEntryCostCapReturnPredecessor, readEntryBufferPredecessor } from './continuation.js';
import { readAutomaticExternalAccount } from './continuous-recovery.js';
import { validateEligibleEntryFilter } from './entry-cost-cap.js';
import { readExternalInventoryProof } from './external-inventory.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const empty = value => value == null || record(value) && Object.keys(value).length === 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const fail = () => { throw new Error('eligible_entry_cost_cap_return_unproven'); };
const reviews = new WeakMap();
const reason = 'user_return_cost_cap';
const proofLifetimeMs = 30000;
const auditLifetimeMs = 10 * 60 * 1000;

// Pin every accounting/authorization field, including unknown future fields.
// Only read diagnostics may advance between private review and taking the lock.
export function entryCostCapReturnStateDigest(state) {
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

function strategyEpochs(config, state, previous, now) {
    const epochs = state.strategyEpochs;
    if (!Array.isArray(epochs) || !epochs.length || new Set(epochs.map(epoch => epoch?.id)).size !== epochs.length
        || epochs.at(-1)?.id !== state.currentStrategyEpochId) fail();
    let completedIndex = 0, snapshotIndex = 0, startedAt = state.startedAt;
    for (const epoch of epochs) {
        if (!record(epoch) || !ID.test(epoch.id) || !ID.test(epoch.runtimeId) || !record(epoch.policy)
            || !timestamp(epoch.startedAt) || epoch.startedAt < startedAt || epoch.startedAt > now
            || !Number.isSafeInteger(epoch.firstCompletedIndex) || epoch.firstCompletedIndex < completedIndex
            || epoch.firstCompletedIndex > state.completed.length
            || !Number.isSafeInteger(epoch.firstSnapshotIndex) || epoch.firstSnapshotIndex < snapshotIndex
            || epoch.firstSnapshotIndex > state.ai.snapshots.length || !Number.isFinite(epoch.cashAtStart)
            || epoch.id !== digest({ periodId: config.id, runtimeId: epoch.runtimeId, startedAt: epoch.startedAt,
                firstCompletedIndex: epoch.firstCompletedIndex, firstSnapshotIndex: epoch.firstSnapshotIndex }).slice(0, 16)) fail();
        completedIndex = epoch.firstCompletedIndex; snapshotIndex = epoch.firstSnapshotIndex; startedAt = epoch.startedAt;
    }
    const current = epochs.at(-1);
    if (!isDeepStrictEqual(current.policy, previous.policy)) fail();
    if (current.runtimeId === previous.runtimeId) return;
    const migration = config.runtimeContinuation.entryCostCapReturn;
    const maintenance = migration.previousContinuation.maintenanceRevision;
    if (maintenance?.previousRuntimeId === current.runtimeId) {
        if (typeof migration.epochContinuationText !== 'string'
            || hash(migration.epochContinuationText) !== maintenance.previousContinuationSha256) fail();
        let approval;
        try { approval = JSON.parse(migration.epochContinuationText); } catch { fail(); }
        const rows = state.runtimeMaintenanceHistory?.filter(row => row?.runtimeId === previous.runtimeId);
        if (!record(approval) || approval.reason !== 'user_entry_buffer' || approval.runtimeId !== current.runtimeId
            || !HASH.test(migration.epochManifestSha256) || !Array.isArray(rows) || rows.length !== 1
            || rows[0].previousRuntimeId !== current.runtimeId || rows[0].policyChanged !== false
            || rows[0].reason !== maintenance.reason || typeof maintenance.reason !== 'string' || !maintenance.reason
            || !timestamp(maintenance.at) || maintenance.at < current.startedAt
            || !timestamp(rows[0].at) || rows[0].at < maintenance.at || rows[0].at > now
            || !HASH.test(rows[0].previousLedgerSha256)
            || ['originalRuntimeId', 'periodId', 'originalManifestSha256', 'riskRecordSha256',
                'fundingSha256', 'ledgerStartedAt'].some(key => approval[key] !== migration.previousContinuation[key])) fail();
        const directory = checkedDirectory(config.settings.dataDir,
            [config.id, 'eligible-runtime', 'revisions', current.runtimeId]);
        const filename = path.join(directory, 'manifest.json');
        if (!fs.lstatSync(filename).isFile()) fail();
        const bytes = fs.readFileSync(filename), manifest = JSON.parse(bytes);
        if (hash(bytes) !== migration.epochManifestSha256 || manifest.id !== config.id
            || manifest.runtimeId !== current.runtimeId || manifest.startedAt !== state.startedAt
            || !isDeepStrictEqual(manifest.policy, previous.policy)
            || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
            || !Array.isArray(manifest.sources) || !manifest.sources.length
            || manifest.sources.some(source => !Array.isArray(source) || source.length !== 2
                || typeof source[0] !== 'string' || !source[0] || path.posix.isAbsolute(source[0])
                || source[0].split('/').some(part => ['', '.', '..'].includes(part)) || !HASH.test(source[1]))
            || new Set(manifest.sources.map(source => source[0])).size !== manifest.sources.length
            || digest({ policy: manifest.policy, sources: manifest.sources,
                profitTaking: manifest.profitTaking }).slice(0, 16) !== current.runtimeId) fail();
        readEntryBufferPredecessor({ ...config, runtimeId: current.runtimeId, policy: manifest.policy }, approval);
        return;
    }
    const history = state.continuousOperationHistory || [];
    const first = history.findIndex(row => row?.runtimeId === current.runtimeId);
    if (first === -1) fail();
    let runtimeId = current.runtimeId, migratedAt = current.startedAt;
    const visited = new Set([runtimeId]);
    for (const row of history.slice(first)) {
        if (!record(row) || row.runtimeId !== runtimeId || !ID.test(row.nextRuntimeId) || visited.has(row.nextRuntimeId)
            || row.enabledAt !== state.continuousOperation.enabledAt || !timestamp(row.migratedAt)
            || row.migratedAt < migratedAt || row.migratedAt > now || !HASH.test(row.beforeSha256)
            || !HASH.test(row.previousManifestSha256)) fail();
        const directory = checkedDirectory(config.settings.dataDir,
            [config.id, 'eligible-runtime', 'revisions', runtimeId]);
        const filename = path.join(directory, 'manifest.json');
        if (!fs.lstatSync(filename).isFile()) fail();
        const bytes = fs.readFileSync(filename), manifest = JSON.parse(bytes);
        if (hash(bytes) !== row.previousManifestSha256 || manifest.id !== config.id || manifest.runtimeId !== runtimeId
            || manifest.startedAt !== state.startedAt || !isDeepStrictEqual(manifest.policy, previous.policy)
            || !isDeepStrictEqual(manifest.profitTaking, config.profitTaking)
            || !Array.isArray(manifest.sources) || !manifest.sources.length
            || manifest.sources.some(source => !Array.isArray(source) || source.length !== 2
                || typeof source[0] !== 'string' || !source[0] || path.posix.isAbsolute(source[0])
                || source[0].split('/').some(part => ['', '.', '..'].includes(part)) || !HASH.test(source[1]))
            || new Set(manifest.sources.map(source => source[0])).size !== manifest.sources.length
            || digest({ policy: manifest.policy, sources: manifest.sources,
                profitTaking: manifest.profitTaking }).slice(0, 16) !== runtimeId) fail();
        runtimeId = row.nextRuntimeId; migratedAt = row.migratedAt; visited.add(runtimeId);
    }
    if (runtimeId !== previous.runtimeId) fail();
}

function candidate(config, state, now) {
    const approval = config.runtimeContinuation, migration = approval?.entryCostCapReturn;
    const { continuousTrading, entryFilter, ...originalPolicy } = config.policy || {};
    if (approval?.reason !== reason || !record(migration)
        || config.settings.continuousTrading !== true || continuousTrading !== true
        || config.policy.provider !== 'eligible' || !entryFilter
        || !isDeepStrictEqual(entryFilter, validateEligibleEntryFilter(entryFilter, { gasUsd: config.policy.execution?.gasUsd }))
        || approval.policyChange?.previousPolicySha256 !== digest(originalPolicy)
        || approval.policyChange?.currentPolicySha256 !== digest(config.policy)
        || !ID.test(config.runtimeId) || approval.runtimeId !== config.runtimeId
        || digest({ policy: config.policy, sources: config.sources, profitTaking: config.profitTaking }).slice(0, 16) !== config.runtimeId
        || !ID.test(approval.originalRuntimeId) || config.riskRuntimeId !== approval.originalRuntimeId
        || config.riskPeriod?.runtimeId !== approval.originalRuntimeId
        || approval.periodId !== config.id || config.riskPeriod?.periodId !== config.id
        || !ID.test(migration.previousRuntimeId) || migration.previousRuntimeId === config.runtimeId
        || !HASH.test(migration.previousManifestSha256) || !HASH.test(migration.stateSha256)
        || state?.baseline !== config.id || state.mode !== 'pilot' || state.strategy !== 'late-entry'
        || state.decisionProvider !== 'eligible' || !timestamp(state.startedAt)
        || state.startedAt !== approval.ledgerStartedAt || !timestamp(now) || now < state.startedAt
        || digest(state.liveFunding) !== approval.fundingSha256
        || entryCostCapReturnStateDigest(state) !== migration.stateSha256
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
        || state.continuousOperationHistory != null && !Array.isArray(state.continuousOperationHistory)) fail();
    const previous = readEntryCostCapReturnPredecessor(config);
    strategyEpochs(config, state, previous, now);
    return migration;
}

// The caller holds the pilot flock for both preparation and apply. No transaction
// builders, cancellations, withdrawals, or inference are admitted by this path.
export async function prepareEntryCostCapReturn(config, state, client, providers, { now = Date.now } = {}) {
    const verificationStartedAt = now();
    const migration = candidate(config, state, verificationStartedAt), beforeSha256 = digest(state), configSha256 = digest(config);
    let lastCheckedAt = verificationStartedAt;
    const guard = () => {
        const at = now();
        if (!timestamp(at) || at < lastCheckedAt || at - verificationStartedAt > auditLifetimeMs
            || digest(state) !== beforeSha256 || digest(config) !== configSha256) fail();
        lastCheckedAt = at;
        candidate(config, state, at);
        return at;
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
    const automatic = config.settings.automaticManualActivity === true;
    const readExternal = (account, anchor) => automatic
        ? readAutomaticExternalAccount(config, state, client, account, anchor, { now, guard })
        : readExternalInventoryProof(config, state, client, account, anchor, { now, guard });
    if (!Array.isArray(checked.account.openOrders) || checked.account.openOrders.length) fail();
    let external = await readExternal(checked.account, proof);
    let trades = automatic ? external.trades
        : await assertPeriodAccountReady(external.account, { client, wallet: config.settings.wallet, proof });
    guard();
    const holdings = [];
    for (const completed of state.completed) {
        const amounts = await client.holdings(completed.tokens, proof.blockNumber);
        guard();
        if (!Array.isArray(amounts) || amounts.length !== 2
            || amounts.some((amount, index) => amount !== (automatic ? external.balances[completed.tokens[index]] || 0 : 0))) fail();
        holdings.push({ conditionId: completed.conditionId, tokens: [...completed.tokens], amounts });
    }
    // Historical proofs may span many markets. Only the final refreshed account
    // and chain checks establish the short window in which apply is permitted.
    const finalVerificationStartedAt = guard();
    const [latest, positions] = await Promise.all([client.ordersAndTrades(), client.positions()]);
    guard();
    if (!record(latest) || !Array.isArray(latest.orders) || latest.orders.length) fail();
    const finalAccount = { ...checked.account, positions, openOrders: latest.orders,
        checks: [{ name: 'authenticated_order_trade_api', detail: latest }] };
    if (!external.proof) trades = await assertPeriodAccountReady(finalAccount,
        { client, wallet: config.settings.wallet, proof });
    guard();
    if (client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash) fail();
    const finalProof = await readPeriodWalletProof(config, client);
    if (external.proof) {
        external = await readExternal(finalAccount, finalProof);
        trades = automatic ? external.trades : await assertPeriodAccountReady(external.account,
            { client, wallet: config.settings.wallet, proof: finalProof });
    }
    const verifiedAt = guard();
    if (!timestamp(verifiedAt) || verifiedAt < finalVerificationStartedAt
        || verifiedAt - finalVerificationStartedAt > proofLifetimeMs
        || finalProof.blockNumber < proof.blockNumber
        || finalProof.blockNumber === proof.blockNumber && finalProof.blockHash !== proof.blockHash
        || ['confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce', 'balance'].some(key => finalProof[key] !== proof[key])) fail();
    const expected = expectedWalletBalance(state);
    if (!Number.isFinite(expected) || Math.abs(proof.balance - expected) > EPS
        || !Number.isFinite(checked.account.wallet?.balance) || Math.abs(checked.account.wallet.balance - proof.balance) > EPS
        || client.rpc.anchor?.number !== finalProof.blockNumber || client.rpc.anchor?.hash !== finalProof.blockHash) fail();
    history();
    const startedAt = guard(), expiresAt = Math.min(finalVerificationStartedAt + proofLifetimeMs,
        verificationStartedAt + auditLifetimeMs), nextState = structuredClone(state);
    if (!timestamp(startedAt) || startedAt < verifiedAt || startedAt > expiresAt) fail();
    const identity = { periodId: config.id, runtimeId: config.runtimeId, startedAt,
        firstCompletedIndex: state.completed.length, firstSnapshotIndex: state.ai.snapshots.length };
    const epoch = { id: digest(identity).slice(0, 16), startedAt, policy: structuredClone(config.policy),
        runtimeId: config.runtimeId, firstCompletedIndex: identity.firstCompletedIndex,
        firstSnapshotIndex: identity.firstSnapshotIndex, cashAtStart: state.cash,
        previousRuntimeId: migration.previousRuntimeId, reason, beforeSha256,
        previousStrategyEpochId: state.currentStrategyEpochId,
        previousManifestSha256: migration.previousManifestSha256,
        previousContinuationSha256: migration.previousContinuationSha256,
        walletProof: { ...finalProof, verificationStartedAt, finalVerificationStartedAt, verifiedAt,
            expectedBalance: expected, trades,
            ...(external.proof ? { externalInventoryProof: external.proof,
                excludedLegacyInventory: external.excludedLegacyInventory || external.proof.excludedLegacyInventory } : {}),
            holdingsProof: { blockNumber: proof.blockNumber, blockHash: proof.blockHash, holdings } } };
    nextState.strategyEpochs = [...(state.strategyEpochs || []), epoch];
    nextState.currentStrategyEpochId = epoch.id;
    nextState.continuousOperationHistory = [...(state.continuousOperationHistory || []),
        { ...state.continuousOperation, migratedAt: startedAt, nextRuntimeId: config.runtimeId,
            previousManifestSha256: migration.previousManifestSha256,
            previousContinuationSha256: migration.previousContinuationSha256, reasonVerified: reason, beforeSha256 }];
    nextState.continuousOperation.runtimeId = config.runtimeId;
    const summary = { ready: true, reason, periodId: config.id, runtimeId: config.runtimeId,
        previousRuntimeId: migration.previousRuntimeId, previousStrategyEpochId: state.currentStrategyEpochId,
        strategyEpochId: epoch.id, previousEpochsPreserved: state.strategyEpochs.length,
        blockNumber: finalProof.blockNumber, blockHash: finalProof.blockHash,
        verificationStartedAt, finalVerificationStartedAt, verifiedAt, expiresAt,
        walletPUSD: finalProof.balance, expectedWalletPUSD: expected, cash: state.cash,
        peakEquity: state.peakEquity, maxDrawdown: state.maxDrawdown, completedMarkets: state.completed.length,
        filledMarkets: state.completed.filter(row => row.traded).length,
        accountingPreserved: true, riskPeriodPreserved: true, stopHistoryPreserved: true,
        financialWrites: false, liveStarted: false };
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
    const archiveDirectory = path.join(root, 'entry-cost-cap-return');
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

export function applyEntryCostCapReturn(store, review, { explicitApply = false } = {}) {
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
