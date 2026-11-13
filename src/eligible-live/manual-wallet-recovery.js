import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ethers } from 'ethers';
import { CONTRACTS, receiptMovements } from '../restart/client.js';
import { expectedWalletBalance } from '../laya-live/recovery.js';
import { accountedCapitalHashes } from '../laya-live/deposits.js';
import { eligibleHistory } from './preflight.js';
import { assertPeriodAccountReady, readPeriodWalletProof } from './period.js';
import { readExternalInventoryProof } from './external-inventory.js';
import { ELIGIBLE_BUFFER_POLICY } from './entry-buffer.js';

const ID = /^[a-f0-9]{16}$/;
const HASH = /^[a-f0-9]{64}$/;
const TX = /^0x[a-f0-9]{64}$/;
const ADDRESS = /^0x[a-f0-9]{40}$/;
const TOKEN = /^[1-9]\d*$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => hash(JSON.stringify(value));
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const fail = () => { throw new Error('eligible_manual_wallet_recovery_unproven'); };
const reviews = new WeakMap();
const reason = 'reviewed_manual_wallet_activity';
const auditLifetimeMs = 600000, proofLifetimeMs = 30000;
const erc20 = new ethers.utils.Interface(['function balanceOf(address) view returns (uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)']);
const ctf = new ethers.utils.Interface(['function balanceOf(address,uint256) view returns (uint256)',
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)',
    'event PayoutRedemption(address indexed redeemer,address indexed collateralToken,bytes32 indexed parentCollectionId,bytes32 conditionId,uint256[] indexSets,uint256 payout)']);

function units(value) {
    if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 1e6))
        || Math.round(value * 1e6) / 1e6 !== value) fail();
    return Math.round(value * 1e6);
}

export function manualWalletRecoveryStateDigest(state) {
    if (!record(state)) fail();
    return digest(state);
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

function ledgerBytes(config, state, approval) {
    const directory = checkedDirectory(config.settings.dataDir, [config.id, 'pilot']);
    const filename = path.join(directory, 'late-entry.json');
    if (!fs.lstatSync(filename).isFile()) fail();
    const bytes = fs.readFileSync(filename);
    if (hash(bytes) !== approval.ledgerSha256 || !isDeepStrictEqual(JSON.parse(bytes), state)) fail();
    return { filename, bytes };
}

function receiptTokens(receipt, approval) {
    const tokens = receipt.tokenIds ?? approval.tokenIds;
    if (!Array.isArray(tokens) || !tokens.length || tokens.some(token => !TOKEN.test(token) || !approval.tokenIds.includes(token))
        || new Set(tokens).size !== tokens.length || !Array.isArray(receipt.holdings)
        || receipt.holdings.length !== tokens.length) fail();
    return tokens;
}

function receiptHoldings(receipt, approval) {
    const tokens = receiptTokens(receipt, approval);
    return approval.tokenIds.map(token => {
        const index = tokens.indexOf(token);
        return index < 0 ? 0 : receipt.holdings[index];
    });
}

function previousExternal(state, approval) {
    const external = state.externalWalletActivity;
    if (external == null) return { cash: 0, receipts: new Map(), inventoryTokens: new Map() };
    if (!record(external) || external.reason !== reason || external.capitalAllocated !== 0
        || !Array.isArray(external.receipts) || !external.receipts.length
        || !Array.isArray(external.zeroPayoutInventory) || !timestamp(external.reviewedAt)
        || !record(external.checkpoint) || external.checkpoint.blockNumber !== approval.checkpoint.blockNumber
        || external.checkpoint.blockHash !== approval.checkpoint.blockHash
        || units(external.checkpoint.balance) !== units(approval.checkpoint.balance)
        || !Array.isArray(state.manualWalletRecoveryHistory) || !state.manualWalletRecoveryHistory.length) fail();
    const receipts = new Map();
    let cash = 0;
    for (const receipt of external.receipts) {
        if (!record(receipt) || !TX.test(receipt.hash) || receipts.has(receipt.hash)
            || !Array.isArray(receipt.tokenIds) || !isDeepStrictEqual(receipt,
                approval.receipts.find(row => row?.hash === receipt.hash))) fail();
        receiptTokens(receipt, approval);
        receipt.holdings.forEach(units); cash += units(receipt.cash); receipts.set(receipt.hash, receipt);
    }
    if (!Number.isSafeInteger(cash) || cash !== units(external.cashDelta) || receipts.size >= approval.receipts.length) fail();
    const inventoryTokens = new Map();
    const inventoryAmounts = new Map();
    for (const inventory of external.zeroPayoutInventory) {
        if (!record(inventory) || !Array.isArray(inventory.tokens) || inventory.tokens.length !== 2
            || !Array.isArray(inventory.amounts) || inventory.amounts.length !== 2
            || !isDeepStrictEqual(inventory.payout, [1, 0]) && !isDeepStrictEqual(inventory.payout, [0, 1])) fail();
        inventory.tokens.forEach((token, index) => {
            if (!TOKEN.test(token) || inventoryAmounts.has(token) || units(inventory.amounts[index]) < 0) fail();
            inventoryAmounts.set(token, units(inventory.amounts[index]));
            if (inventory.amounts[index] > 0) {
                if (inventory.payout[index] !== 0 || !approval.tokenIds.includes(token)) fail();
                inventoryTokens.set(token, inventory);
            }
        });
    }
    for (const [index, token] of approval.tokenIds.entries()) {
        const amount = external.receipts.reduce((sum, row) => sum + units(receiptHoldings(row, approval)[index]), 0);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount !== (inventoryAmounts.get(token) || 0)) fail();
    }
    return { cash, receipts, inventoryTokens };
}

function incident(config, state, approval) {
    const sameRuntime = approval.previousRuntimeId === config.runtimeId;
    if (sameRuntime) {
        const epoch = state.strategyEpochs?.at(-1);
        if (!isDeepStrictEqual(config.policy.entryFilter, ELIGIBLE_BUFFER_POLICY)
            || !record(epoch) || !ID.test(epoch.id) || epoch.runtimeId !== config.runtimeId || epoch.id !== state.currentStrategyEpochId
            || !isDeepStrictEqual(epoch.policy, config.policy)
            || state.externalWalletActivity == null) fail();
    } else if (config.runtimeContinuation.entryBufferMigration?.previousRuntimeId !== approval.previousRuntimeId
        || state.externalWalletActivity != null || state.manualWalletRecoveryHistory != null) fail();
    if (state.stopped === null && sameRuntime) {
        if (approval.stop !== null || approval.hold !== null || approval.fault !== null
            || !record(state.entryHolds) || Object.keys(state.entryHolds).length
            || !record(state.reconciliationFaults) || Object.keys(state.reconciliationFaults).length) fail();
        return;
    }
    if (!isDeepStrictEqual(state.stopped, approval.stop) || state.stopped?.reason !== 'wallet_ledger_mismatch'
        || !timestamp(state.stopped.at) || !record(state.entryHolds) || Object.keys(state.entryHolds).length !== 1
        || !isDeepStrictEqual(state.entryHolds.capital_deposit, approval.hold)
        || approval.hold?.error?.code !== 'capital_deposit_verifying' || approval.hold.error.stage !== 'capital_deposit'
        || !record(state.reconciliationFaults) || Object.keys(state.reconciliationFaults).length !== 1
        || !isDeepStrictEqual(state.reconciliationFaults.wallet_ledger_mismatch, approval.fault)
        || !record(approval.fault)) fail();
}

function candidate(config, state) {
    const approval = config.manualWalletRecovery;
    if (!record(approval) || approval.schema !== 1 || approval.reason !== reason
        || !ID.test(config.id) || !ID.test(config.runtimeId) || approval.periodId !== config.id
        || config.settings.continuousTrading !== true || config.policy?.continuousTrading !== true
        || config.policy.provider !== 'eligible' || config.runtimeContinuation?.reason !== 'user_entry_buffer'
        || config.runtimeContinuation.runtimeId !== config.runtimeId || config.runtimeContinuation.periodId !== config.id
        || config.runtimeContinuation.ledgerStartedAt !== state?.startedAt
        || config.runtimeContinuation.fundingSha256 !== digest(state?.liveFunding)
        || approval.runtimeId !== config.runtimeId || !ID.test(approval.previousRuntimeId)
        || state?.continuousOperation?.runtimeId !== approval.previousRuntimeId
        || !ADDRESS.test(approval.wallet) || approval.wallet !== lower(config.settings.wallet)
        || !HASH.test(approval.ledgerSha256) || !HASH.test(approval.stateSha256)
        || manualWalletRecoveryStateDigest(state) !== approval.stateSha256
        || state.baseline !== config.id || state.mode !== 'pilot' || state.strategy !== 'late-entry'
        || state.decisionProvider !== 'eligible' || !timestamp(state.startedAt)
        || state.position != null || state.liveRiskStop != null || state.frozenAt != null
        || state.profitTaking?.pending != null
        || state.profitTakingControl?.operation != null || !record(state.ai?.providers)
        || Object.values(state.ai.providers).some(provider => !record(provider) || provider.pending || provider.disabled)
        || !Array.isArray(state.completed) || !record(state.seen)
        || state.completed.some(row => !record(row) || row.uncertain || row.pendingTrades
            || !Array.isArray(row.tokens) || row.tokens.length !== 2 || row.tokens.some(token => !TOKEN.test(token))
            || row.actions != null && (!Array.isArray(row.actions)
                || row.actions.some(action => !record(action) || !['confirmed', 'failed'].includes(action.status)))
            || row.orders != null && (!Array.isArray(row.orders)
                || row.orders.some(order => !record(order) || !['complete', 'rejected', 'cancelled'].includes(order.status))))
        || state.stopHistory != null && !Array.isArray(state.stopHistory)
        || state.manualWalletRecoveryHistory != null && !Array.isArray(state.manualWalletRecoveryHistory)
        || !record(approval.checkpoint) || !timestamp(approval.checkpoint.blockNumber) || !TX.test(approval.checkpoint.blockHash)
        || !isDeepStrictEqual(state.capitalFunding?.checkpoint,
            { blockNumber: approval.checkpoint.blockNumber, blockHash: approval.checkpoint.blockHash })
        || !Array.isArray(approval.tokenIds) || !approval.tokenIds.length || approval.tokenIds.some(token => !TOKEN.test(token))
        || new Set(approval.tokenIds).size !== approval.tokenIds.length
        || state.completed.some(row => row.tokens.some(token => approval.tokenIds.includes(token)))
        || !Array.isArray(approval.receipts) || !approval.receipts.length || approval.receipts.length > 100
        || !Array.isArray(approval.zeroPayoutInventory)
        || new Set(approval.receipts.map(row => row?.hash)).size !== approval.receipts.length) fail();
    incident(config, state, approval);
    const previous = previousExternal(state, approval);
    const accounted = new Set(accountedCapitalHashes({ ...state, externalWalletActivity: null }));
    const owned = new Set(JSON.stringify([state.completed, state.settlementEvidence])?.match(/0x[a-fA-F0-9]{64}/g)?.map(lower));
    let cash = 0;
    for (const receipt of approval.receipts) {
        if (!record(receipt) || !TX.test(receipt.hash) || accounted.has(receipt.hash) || owned.has(receipt.hash)
            || !timestamp(receipt.blockNumber) || receipt.blockNumber <= approval.checkpoint.blockNumber
            || !TX.test(receipt.blockHash)) fail();
        receiptTokens(receipt, approval);
        cash += units(receipt.cash);
        receipt.holdings.forEach(units);
    }
    const inventoryAmounts = new Map();
    for (const inventory of approval.zeroPayoutInventory) {
        if (!record(inventory) || !Array.isArray(inventory.tokens) || inventory.tokens.length !== 2
            || !Array.isArray(inventory.amounts) || inventory.amounts.length !== 2) fail();
        inventory.tokens.forEach((token, index) => {
            if (inventoryAmounts.has(token) || !TOKEN.test(token) || units(inventory.amounts[index]) < 0) fail();
            inventoryAmounts.set(token, units(inventory.amounts[index]));
            if (inventory.amounts[index] !== 0 && !approval.tokenIds.includes(token)) fail();
        });
    }
    for (const [index, token] of approval.tokenIds.entries()) {
        const amount = approval.receipts.reduce((sum, row) => sum + units(receiptHoldings(row, approval)[index]), 0);
        if (!Number.isSafeInteger(amount) || amount < 0 || amount !== (inventoryAmounts.get(token) || 0)) fail();
    }
    if (!Number.isSafeInteger(cash) || cash !== units(approval.cashDelta)
        || units(expectedWalletBalance(state)) !== units(approval.expectedWalletBefore)
        || units(approval.checkpoint.balance) + previous.cash !== units(approval.expectedWalletBefore)
        || units(approval.expectedWalletBefore) + cash - previous.cash !== units(approval.expectedWalletAfter)
        || units(approval.expectedWalletAfter) < units(state.cash)) fail();
    if (config.manualWalletReviewFile) {
        const file = config.manualWalletReviewFile;
        if (!path.isAbsolute(file.path) || !HASH.test(file.sha256) || !fs.lstatSync(file.path).isFile()
            || hash(fs.readFileSync(file.path)) !== file.sha256) fail();
    }
    ledgerBytes(config, state, approval);
    return approval;
}

function canonicalLosingBurn(transfer, logs, inventory, wallet) {
    const operator = lower(CONTRACTS.autoRedeemOperator), zero = ethers.constants.AddressZero;
    if (transfer.name !== 'TransferBatch' || lower(transfer.args.operator) !== operator
        || lower(transfer.args.to) !== operator || transfer.args.ids.length !== 2
        || new Set(transfer.args.ids.map(String)).size !== 2) fail();
    const amounts = inventory.tokens.map((token, index) => {
        const i = transfer.args.ids.findIndex(id => id.toString() === token);
        if (i < 0 || inventory.payout[index] !== 0 && !transfer.args[4][i].isZero()) fail();
        return transfer.args[4][i];
    });
    const held = amounts.findIndex(amount => !amount.isZero());
    if (held < 0 || amounts.filter(amount => !amount.isZero()).length !== 1) fail();
    const mint = logs.find(log => log.logIndex > transfer.logIndex && log.name === 'Transfer'
        && lower(log.args.to) === wallet);
    if (!mint || lower(mint.args.from) !== zero || !mint.args.value.isZero()) fail();
    // Auto-redemption batches many wallets; bind this losing burn to the
    // segment ending at this wallet's own zero-pUSD mint.
    const segment = logs.filter(log => log.logIndex > transfer.logIndex && log.logIndex < mint.logIndex);
    const payouts = segment.filter(log => log.name === 'PayoutRedemption');
    const burns = segment.filter(log => ['TransferSingle', 'TransferBatch'].includes(log.name));
    if (payouts.length !== 1 || burns.length !== 1) fail();
    const payout = payouts[0], burn = burns[0];
    if (lower(payout.args.redeemer) !== operator
        || lower(payout.args.collateralToken) !== '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
        || lower(payout.args.parentCollectionId) !== ethers.constants.HashZero
        || lower(payout.args.conditionId) !== lower(inventory.conditionId)
        || !isDeepStrictEqual(payout.args.indexSets.map(String), ['1', '2']) || !payout.args.payout.isZero()
        || burn.name !== 'TransferSingle' || lower(burn.args.operator) !== operator
        || lower(burn.args.from) !== operator || lower(burn.args.to) !== zero
        || burn.args.id.toString() !== inventory.tokens[held] || !burn.args.value.eq(amounts[held])
        || burn.logIndex >= payout.logIndex) fail();
}

function receiptProof(receipt, expected, approval, block, burnOnly = new Map()) {
    const wallet = approval.wallet, tokens = approval.tokenIds;
    if (!record(receipt) || lower(receipt.transactionHash) !== expected.hash || receipt.status !== 1
        || receipt.blockNumber !== expected.blockNumber || lower(receipt.blockHash) !== expected.blockHash
        || receipt.blockNumber > block || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2
        || !Array.isArray(receipt.logs) || !receipt.logs.length) fail();
    let previousIndex = -1;
    const decoded = [];
    for (const log of receipt.logs) {
        if (!record(log) || !ADDRESS.test(lower(log.address)) || !Number.isSafeInteger(log.logIndex)
            || log.logIndex <= previousIndex || log.removed === true
            || log.transactionHash !== undefined && lower(log.transactionHash) !== expected.hash
            || log.blockHash !== undefined && lower(log.blockHash) !== expected.blockHash
            || log.blockNumber !== undefined && log.blockNumber !== expected.blockNumber
            || !Array.isArray(log.topics) || log.topics.some(topic => !TX.test(lower(topic)))
            || !/^0x(?:[a-fA-F0-9]{2})*$/.test(log.data || '')) fail();
        previousIndex = log.logIndex;
        const abi = lower(log.address) === lower(CONTRACTS.collateralToken) ? erc20
            : lower(log.address) === lower(CONTRACTS.conditionalTokens) ? ctf : null;
        if (!abi || !Object.values(abi.events).some(event => lower(abi.getEventTopic(event)) === lower(log.topics[0]))) continue;
        let event;
        try { event = abi.parseLog(log); } catch { fail(); }
        decoded.push({ ...event, logIndex: log.logIndex });
        if (abi === ctf && ['TransferSingle', 'TransferBatch'].includes(event.name)
            && [event.args.from, event.args.to].some(address => lower(address) === wallet)) {
            const ids = event.name === 'TransferBatch' ? event.args.ids : [event.args.id];
            const amounts = event.name === 'TransferBatch' ? event.args[4] : [event.args.value];
            if (ids.length !== amounts.length || ids.some((id, index) =>
                !tokens.includes(id.toString()) && !amounts[index].isZero())) fail();
        }
    }
    for (const event of decoded) if (['TransferSingle', 'TransferBatch'].includes(event.name)
        && lower(event.args.from) === wallet && lower(event.args.to) !== ethers.constants.AddressZero) {
        const ids = event.name === 'TransferBatch' ? event.args.ids : [event.args.id];
        const amounts = event.name === 'TransferBatch' ? event.args[4] : [event.args.value];
        for (const [index, id] of ids.entries()) if (burnOnly.has(id.toString()) && !amounts[index].isZero())
            canonicalLosingBurn(event, decoded, burnOnly.get(id.toString()), wallet);
    }
    const movement = receiptMovements(receipt, wallet, tokens);
    if (units(movement.cash) !== units(expected.cash)
        || !isDeepStrictEqual(movement.holdings, receiptHoldings(expected, approval))) fail();
    return { ...structuredClone(expected), cash: movement.cash,
        tokenIds: [...receiptTokens(expected, approval)], holdings: [...expected.holdings] };
}

async function checkpointProof(config, approval, client, proof, guard) {
    const checkpoint = approval.checkpoint, tag = ethers.utils.hexValue(checkpoint.blockNumber);
    const pinned = async (task, key) => {
        guard();
        if (client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor.hash !== proof.blockHash) fail();
        const result = await client.rpc.read('eligible_manual_wallet_checkpoint', task, proof.blockNumber,
            `manual_checkpoint:${checkpoint.blockNumber}:${checkpoint.blockHash}:${key}`);
        guard();
        if (client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor.hash !== proof.blockHash) fail();
        return result;
    };
    const header = async key => pinned(async provider => {
        const [chain, block] = await Promise.all([provider.send('eth_chainId', []),
            provider.send('eth_getBlockByNumber', [tag, false])]);
        if (Number(chain) !== 137 || Number(block?.number) !== checkpoint.blockNumber
            || lower(block?.hash) !== checkpoint.blockHash) fail();
    }, key);
    const read = (to, data, key) => pinned(provider => provider.send('eth_call', [{ to, data }, tag]), key);
    await header('before');
    const raw = await read(CONTRACTS.collateralToken, erc20.encodeFunctionData('balanceOf', [config.settings.wallet]), 'cash');
    if (erc20.decodeFunctionResult('balanceOf', raw)[0].toString() !== String(units(checkpoint.balance))) fail();
    // Each historical balance gets its own bounded RPC read; a growing token
    // union must not turn one three-second coordinator task into a long batch.
    for (const token of approval.tokenIds) {
        const raw = await read(CONTRACTS.conditionalTokens,
            ctf.encodeFunctionData('balanceOf', [config.settings.wallet, token]), `token:${token}`);
        if (!ctf.decodeFunctionResult('balanceOf', raw)[0].isZero()) fail();
    }
    await header('after');
    return { ...checkpoint, tokenIds: [...approval.tokenIds], holdings: approval.tokenIds.map(() => 0) };
}

// The pilot lock spans preparation and apply. Every import pins the full ledger
// and aggregate receipts; no transaction or activation method is used.
export async function prepareManualWalletRecovery(config, state, client, { now = Date.now } = {}) {
    const verificationStartedAt = now(), approval = candidate(config, state);
    const beforeSha256 = digest(state), configSha256 = digest(config);
    let lastAt = verificationStartedAt;
    const guard = () => {
        const at = now();
        if (!timestamp(at) || at < lastAt || at - verificationStartedAt > auditLifetimeMs
            || digest(state) !== beforeSha256 || digest(config) !== configSha256) fail();
        lastAt = at; candidate(config, state); return at;
    };
    const history = () => {
        guard();
        const rows = eligibleHistory(config);
        if (!isDeepStrictEqual(rows.find(row => row.baseline === config.id && row.strategy === 'late-entry'), state)) fail();
        return rows;
    };
    history();
    const proof = await readPeriodWalletProof(config, client);
    guard();
    if (units(proof.balance) !== units(approval.expectedWalletAfter)
        || approval.receipts.some(row => row.blockNumber > proof.blockNumber)) fail();
    const checkpoint = await checkpointProof(config, approval, client, proof, guard);
    guard();
    const previous = previousExternal(state, approval), verified = new Map();
    for (const expected of approval.receipts) {
        const receipt = await client.verifiedReceipt(expected.hash, proof.blockNumber);
        guard();
        verified.set(expected.hash, receiptProof(receipt, expected, approval, proof.blockNumber,
            previous.receipts.has(expected.hash) ? new Map() : previous.inventoryTokens));
    }
    const receipts = [...previous.receipts.values()].map(row => structuredClone(row));
    for (const [hash, receipt] of verified) if (!previous.receipts.has(hash)) receipts.push(receipt);
    const nextState = structuredClone(state);
    nextState.externalWalletActivity = { ...structuredClone(state.externalWalletActivity || {}), cashDelta: approval.cashDelta, receipts,
        zeroPayoutInventory: structuredClone(approval.zeroPayoutInventory), reviewedAt: guard(),
        capitalAllocated: 0, checkpoint, reason, approvalSha256: digest(approval), beforeSha256 };
    const holdings = [];
    for (const completed of state.completed) {
        const amounts = await client.holdings(completed.tokens, proof.blockNumber);
        guard();
        if (!Array.isArray(amounts) || amounts.length !== 2 || amounts.some(amount => amount !== 0)) fail();
        holdings.push({ conditionId: completed.conditionId, tokens: [...completed.tokens], amounts });
    }
    const manualAmounts = await client.holdings(approval.tokenIds, proof.blockNumber);
    guard();
    if (!Array.isArray(manualAmounts) || manualAmounts.length !== approval.tokenIds.length
        || manualAmounts.some((amount, index) => units(amount) !== receipts.reduce((sum, row) =>
            sum + units(receiptHoldings(row, approval)[index]), 0))) fail();
    // Refresh every global account view after the historical receipt/holding scan.
    const finalVerificationStartedAt = guard();
    const [latest, positions] = await Promise.all([client.ordersAndTrades(), client.positions()]);
    guard();
    if (!record(latest) || !Array.isArray(latest.orders) || latest.orders.length) fail();
    const account = { positions, openOrders: latest.orders,
        checks: [{ name: 'authenticated_order_trade_api', detail: { trades: latest.trades } }] };
    let external = await readExternalInventoryProof(config, nextState, client, account, proof, { now, guard });
    guard();
    const trades = await assertPeriodAccountReady(external.account, { client, wallet: config.settings.wallet, proof });
    guard();
    if (client.rpc.anchor?.number !== proof.blockNumber || client.rpc.anchor?.hash !== proof.blockHash) fail();
    const finalProof = await readPeriodWalletProof(config, client);
    guard();
    const finalManualAmounts = await client.holdings(approval.tokenIds, finalProof.blockNumber);
    guard();
    if (!isDeepStrictEqual(finalManualAmounts, manualAmounts)) fail();
    external = await readExternalInventoryProof(config, nextState, client, account, finalProof, { now, guard });
    guard();
    await client.rpc.read('eligible_manual_wallet_final_anchor', async provider => {
        const header = await provider.send('eth_getBlockByNumber', [ethers.utils.hexValue(proof.blockNumber), false]);
        if (lower(header?.hash) !== proof.blockHash) fail();
    }, finalProof.blockNumber);
    const verifiedAt = guard();
    if (verifiedAt - finalVerificationStartedAt > proofLifetimeMs || finalProof.blockNumber < proof.blockNumber
        || finalProof.blockNumber === proof.blockNumber && finalProof.blockHash !== proof.blockHash
        || ['confirmedNonce', 'pendingNonce', 'safeNonce', 'pendingSafeNonce', 'balance'].some(key => finalProof[key] !== proof[key])
        || units(expectedWalletBalance(nextState)) !== units(finalProof.balance)
        || client.rpc.anchor?.number !== finalProof.blockNumber || client.rpc.anchor?.hash !== finalProof.blockHash) fail();
    history();
    const recoveredAt = guard(), expiresAt = Math.min(finalVerificationStartedAt + proofLifetimeMs, verificationStartedAt + auditLifetimeMs);
    if (recoveredAt > expiresAt) fail();
    const walletProof = { ...finalProof, verificationStartedAt, finalVerificationStartedAt, verifiedAt,
        expectedBalance: approval.expectedWalletAfter, trades, externalInventory: external.proof,
        holdingsProof: { blockNumber: proof.blockNumber, blockHash: proof.blockHash, holdings },
        manualHoldingsProof: { blockNumber: finalProof.blockNumber, blockHash: finalProof.blockHash, amounts: finalManualAmounts } };
    nextState.externalWalletActivity.walletProof = walletProof;
    if (state.stopped !== null) {
        nextState.stopHistory = [...(state.stopHistory || []), { ...state.stopped, recoveredAt,
            reasonVerified: reason, runtimeId: config.runtimeId, beforeSha256, ledgerSha256: approval.ledgerSha256,
            originalHold: structuredClone(approval.hold), originalFault: structuredClone(approval.fault), walletProof }];
        nextState.stopped = null;
        delete nextState.entryHolds.capital_deposit;
        delete nextState.reconciliationFaults.wallet_ledger_mismatch;
    }
    const oldExternalCashDelta = previous.cash / 1e6, newlyReviewedCashDelta = (units(approval.cashDelta) - previous.cash) / 1e6;
    nextState.manualWalletRecoveryHistory = [...(state.manualWalletRecoveryHistory || []), { recoveredAt, reason, beforeSha256,
        ledgerSha256: approval.ledgerSha256, approvalSha256: digest(approval),
        oldExternalCashDelta, newlyReviewedCashDelta,
        previousExternalWalletActivity: structuredClone(state.externalWalletActivity || null),
        stop: structuredClone(approval.stop), hold: structuredClone(approval.hold), fault: structuredClone(approval.fault) }];
    const summary = { ready: true, reason, periodId: config.id, runtimeId: config.runtimeId,
        verificationStartedAt, finalVerificationStartedAt, verifiedAt, expiresAt,
        blockNumber: finalProof.blockNumber, blockHash: finalProof.blockHash, receiptCount: receipts.length,
        externalCashDelta: approval.cashDelta, oldExternalCashDelta, newlyReviewedCashDelta,
        newlyReviewedReceiptCount: receipts.length - previous.receipts.size, expectedWalletBefore: approval.expectedWalletBefore,
        walletPUSD: finalProof.balance, cash: state.cash, peakEquity: state.peakEquity, maxDrawdown: state.maxDrawdown,
        completedMarkets: state.completed.length, externalInventoryMarkets: approval.zeroPayoutInventory.length,
        accountingPreserved: true, financialWrites: false, liveStarted: false };
    const review = { summary, nextState, beforeSha256 };
    reviews.set(review, { config, state, approval, beforeSha256, nextSha256: digest(nextState),
        summarySha256: digest(summary), verifiedAt, expiresAt, now, history });
    return review;
}

function archiveLedger(store, prepared) {
    const { filename, bytes } = ledgerBytes(prepared.config, store.state, prepared.approval);
    if (store.filename !== filename) fail();
    const root = checkedDirectory(prepared.config.settings.dataDir, [prepared.config.id, 'eligible-runtime']);
    const directory = path.join(root, 'manual-wallet-recovery');
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(directory).isDirectory()) fail();
    const archivePath = path.join(directory, `${prepared.approval.ledgerSha256}.json`);
    let fd;
    try {
        fd = fs.openSync(archivePath, 'wx', 0o400); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } catch (error) {
        if (error.code !== 'EEXIST' || !fs.lstatSync(archivePath).isFile() || !fs.readFileSync(archivePath).equals(bytes)) throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    for (const target of [directory, root]) {
        const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return { archivePath, archiveSha256: prepared.approval.ledgerSha256 };
}

export function applyManualWalletRecovery(store, review, { explicitApply = false } = {}) {
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
    const archived = archiveLedger(store, prepared);
    fresh();
    const keys = ['externalWalletActivity', 'manualWalletRecoveryHistory',
        ...(store.state.stopped !== null ? ['stopped', 'entryHolds', 'reconciliationFaults', 'stopHistory'] : [])];
    const previous = new Map(keys.map(key => [key, { exists: Object.hasOwn(store.state, key), value: store.state[key] }]));
    for (const key of keys) store.state[key] = structuredClone(review.nextState[key]);
    try { store.save(); } catch (error) {
        for (const [key, old] of previous) { if (old.exists) store.state[key] = old.value; else delete store.state[key]; }
        throw error;
    }
    reviews.delete(review);
    return { ...review.summary, ...archived };
}
