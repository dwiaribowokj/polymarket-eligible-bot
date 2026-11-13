import { ethers } from 'ethers';
import { OperationalError } from '../restart/network.js';

// This route is deliberately fixed. A paused native-USDC offramp never changes
// the asset delivered to the user, and bridge completion is not a receipt proof.
export const BRIDGE = Object.freeze({ baseUrl: 'https://bridge.polymarket.com', chainId: 137,
    sourceToken: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
    intermediateToken: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    destinationToken: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' });
const ADDRESS = /^0x[\da-f]{40}$/i, HASH = /^0x[\da-f]{64}$/i, HEX = /^0x(?:[\da-f]{2})*$/i;
const UINT = /^(?:0|[1-9]\d*)$/, ZERO = ethers.constants.AddressZero, ZERO_HASH = ethers.constants.HashZero;
const MAX_UINT = (1n << 256n) - 1n, SCALE = 1000000;
export const BRIDGE_MAX_OUTPUT_UNITS = String(Number.MAX_SAFE_INTEGER);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const same = (a, b) => ADDRESS.test(a || '') && lower(a) === lower(b);
const validAddress = value => ADDRESS.test(value || '') && !same(value, ZERO);
const validHash = value => HASH.test(value || '') && lower(value) !== ZERO_HASH;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const signedFinite = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, stage = 'bridge_validation') => {
    throw new OperationalError(code, 'validation', { stage, endpoint: 'polymarket_bridge' });
};
const erc20 = new ethers.utils.Interface(['function balanceOf(address owner) view returns(uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)']);
const transferTopic = lower(erc20.getEventTopic('Transfer'));
const feeFields = ['appFeePercent', 'appFeeUsd', 'fillCostPercent', 'fillCostUsd', 'gasUsd',
    'maxSlippage', 'minReceived', 'swapImpact', 'swapImpactUsd', 'totalImpact', 'totalImpactUsd'];
const signedImpactFields = new Set(['swapImpact', 'swapImpactUsd', 'totalImpact', 'totalImpactUsd']);
const statuses = new Set(['DEPOSIT_DETECTED', 'PROCESSING', 'ORIGIN_TX_CONFIRMED', 'SUBMITTED', 'COMPLETED', 'FAILED']);

// EIP-7702 writes a 23-byte delegation designator onto an EOA. An ERC-20
// transfer changes balances without invoking recipient code, so delegated EOAs
// remain valid destinations. Arbitrary contracts and malformed markers fail.
export function bridgeRecipientAccount(code) {
    if (code === '0x') return { kind: 'eoa', delegate: null };
    if (typeof code === 'string' && /^0xef0100[\da-f]{40}$/i.test(code)) {
        const delegate = `0x${code.slice(8)}`;
        if (validAddress(delegate)) return { kind: 'delegated_eoa', delegate: lower(delegate) };
    }
    fail('bridge_recipient_not_eoa');
}

function uint(value, positive = false) {
    const text = typeof value === 'bigint' ? value.toString() : value;
    if (typeof text !== 'string' || !UINT.test(text)) fail('invalid_bridge_amount');
    const result = BigInt(text);
    if (result > MAX_UINT || positive && result === 0n) fail('invalid_bridge_amount');
    return result;
}

function feeUnits(value) {
    const scaled = value * SCALE, rounded = Math.round(scaled);
    if (!finite(value) || !Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > .00001)
        fail('invalid_bridge_fee_cap');
    return BigInt(rounded);
}

function route({ wallet, recipient, amountUnits = '5000000' } = {}) {
    if (!validAddress(recipient) || same(recipient, BRIDGE.sourceToken) || same(recipient, BRIDGE.destinationToken)
        || wallet !== undefined && (!validAddress(wallet) || same(wallet, recipient))) fail('invalid_bridge_route');
    const amount = uint(amountUnits, true);
    if (amount !== 5000000n) fail('invalid_bridge_chunk');
    return { wallet: wallet === undefined ? undefined : lower(wallet), recipient: lower(recipient), amountUnits: amount.toString() };
}

export function bridgeQuoteRequest(options) {
    const selected = route(options);
    return { fromAmountBaseUnit: selected.amountUnits, fromChainId: '137', fromTokenAddress: BRIDGE.sourceToken,
        recipientAddress: selected.recipient, toChainId: '137', toTokenAddress: BRIDGE.destinationToken };
}

export function bridgeWithdrawalRequest(options) {
    const selected = route(options);
    if (!selected.wallet) fail('invalid_bridge_route');
    return { address: selected.wallet, toChainId: '137', toTokenAddress: BRIDGE.destinationToken,
        recipientAddr: selected.recipient };
}

export function parseBridgeAssets(response, { amountUnits = '5000000' } = {}) {
    const amount = uint(amountUnits, true);
    if (!object(response) || !Array.isArray(response.supportedAssets)) fail('invalid_bridge_supported_assets');
    const tokens = [BRIDGE.sourceToken, BRIDGE.destinationToken].map(token => {
        const found = response.supportedAssets.filter(row => row?.chainId === '137' && same(row.token?.address, token));
        if (found.length !== 1 || found[0].token.decimals !== 6 || !finite(found[0].minCheckoutUsd)
            || found[0].minCheckoutUsd <= 0) fail('invalid_bridge_supported_assets');
        return { token: lower(token), decimals: 6, minCheckoutUsd: found[0].minCheckoutUsd };
    });
    const minimumUsd = Math.max(...tokens.map(row => row.minCheckoutUsd));
    if (Number(amount) / SCALE < minimumUsd) fail('bridge_below_minimum');
    return { chainId: 137, minimumUsd, tokens };
}

// Every documented numeric fee is required. Missing data must not turn into a
// zero fee. minReceived is an estimate in the provider's valuation, not a
// quote-bound on-chain minimum: /withdraw has no minimum-output parameter.
export function parseBridgeQuote(response, options = {}) {
    const selected = route(options), cap = feeUnits(options.maxFeeUsd);
    if (!finite(options.maxSlippagePercent) || options.maxSlippagePercent > 100 || cap >= uint(selected.amountUnits))
        fail('invalid_bridge_fee_cap');
    const fees = response?.estFeeBreakdown;
    if (!object(response) || !object(fees) || feeFields.some(key =>
        !(signedImpactFields.has(key) ? signedFinite : finite)(fees[key]))
        || typeof fees.appFeeLabel !== 'string' || !fees.appFeeLabel || fees.appFeeLabel.length > 128
        || !integer(response.estCheckoutTimeMs) || !finite(response.estInputUsd) || response.estInputUsd <= 0
        || !finite(response.estOutputUsd) || response.estOutputUsd <= 0
        || typeof response.quoteId !== 'string' || !response.quoteId || response.quoteId.length > 256)
        fail('invalid_bridge_quote');
    const output = uint(response.estToTokenBaseUnit, true), input = uint(selected.amountUnits);
    // totalImpact overlaps the itemized provider charges. Use the larger cost
    // rather than adding both representations of the same fee.
    const estimatedCostUsd = fees.gasUsd + Math.max(0, fees.totalImpactUsd,
        fees.appFeeUsd + fees.fillCostUsd + Math.max(0, fees.swapImpactUsd));
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd > options.maxFeeUsd
        || fees.maxSlippage > options.maxSlippagePercent || output > BigInt(BRIDGE_MAX_OUTPUT_UNITS) || input - output > cap)
        fail('bridge_quote_exceeds_budget');
    return { ...selected, chainId: 137, sourceToken: lower(BRIDGE.sourceToken), destinationToken: lower(BRIDGE.destinationToken),
        quoteId: response.quoteId, estimatedOutputUnits: output.toString(),
        minOutputUnits: (input - cap).toString(), maxOutputUnits: (output > input ? output : input).toString(),
        estimatedInputUsd: response.estInputUsd, estimatedOutputUsd: response.estOutputUsd,
        estimatedCheckoutTimeMs: response.estCheckoutTimeMs, estimatedCostUsd, gasReserveUsd: fees.gasUsd,
        providerFeesUsd: estimatedCostUsd - fees.gasUsd,
        maxFeeUsd: options.maxFeeUsd, maxSlippagePercent: options.maxSlippagePercent,
        fees: Object.fromEntries(['appFeeLabel', ...feeFields].map(key => [key, fees[key]])) };
}

// Thirty seconds is a local freshness ceiling, not a provider price guarantee.
export function assertBridgeQuoteFresh(quote, { now = Date.now(), wallet, recipient, maxAgeMs = 30000 } = {}) {
    const expected = route({ wallet, recipient }), selected = route(quote);
    if (!integer(now) || !integer(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30000 || !integer(quote.quotedAt)
        || !integer(quote.expiresAt) || quote.expiresAt !== quote.quotedAt + 30000 || now < quote.quotedAt
        || now >= quote.expiresAt || now - quote.quotedAt >= maxAgeMs || selected.recipient !== expected.recipient
        || expected.wallet !== undefined && selected.wallet !== expected.wallet || quote.chainId !== 137
        || !same(quote.sourceToken, BRIDGE.sourceToken) || !same(quote.destinationToken, BRIDGE.destinationToken))
        fail('bridge_quote_expired_or_mismatched');
    return true;
}

export function parseBridgeWithdrawal(response, options) {
    const selected = route(options), address = response?.address?.evm;
    if (!validAddress(address) || same(address, selected.wallet) || same(address, selected.recipient)
        || same(address, BRIDGE.sourceToken) || same(address, BRIDGE.destinationToken)) fail('invalid_bridge_withdrawal_address');
    return { address: lower(address), ...selected, chainId: 137,
        sourceToken: lower(BRIDGE.sourceToken), destinationToken: lower(BRIDGE.destinationToken) };
}

function optionalAddress(row, keys, expected, code) {
    for (const key of keys) if (row[key] !== undefined && (!validAddress(row[key]) || !same(row[key], expected)))
        fail(code, 'bridge_status');
}

export function parseBridgeStatus(response, options = {}) {
    const selected = route(options);
    if (!validAddress(options.address) || !validHash(options.sourceHash) || !integer(options.createdAt)
        || !object(response) || !Array.isArray(response.transactions)
        || !(response.nextCursor === null || typeof response.nextCursor === 'string' && response.nextCursor.length > 0
            && response.nextCursor.length <= 4096)) fail('invalid_bridge_status', 'bridge_status');
    const matched = [], intermediates = [];
    for (const row of response.transactions) {
        if (!object(row) || typeof row.fromChainId !== 'string' || typeof row.toChainId !== 'string'
            || !validAddress(row.fromTokenAddress) || !validAddress(row.toTokenAddress) || !statuses.has(row.status))
            fail('invalid_bridge_status', 'bridge_status');
        uint(row.fromAmountBaseUnit, true);
        if (row.createdTimeMs !== undefined && !integer(row.createdTimeMs)) fail('invalid_bridge_status', 'bridge_status');
        if (row.createdTimeMs !== undefined && row.createdTimeMs < options.createdAt) continue;
        // The official bridge exposes the pUSD unwrap and its USDC.e funding
        // operation as separate rows. Both are discovery evidence only; an
        // intermediate row must never replace the primary withdrawal match.
        const intermediate = same(row.fromTokenAddress, BRIDGE.intermediateToken);
        if (row.fromChainId !== '137' || row.toChainId !== '137'
            || !same(row.fromTokenAddress, BRIDGE.sourceToken) && !intermediate
            || !same(row.toTokenAddress, BRIDGE.destinationToken) || row.fromAmountBaseUnit !== selected.amountUnits)
            fail('bridge_status_identity_mismatch', 'bridge_status');
        optionalAddress(row, ['recipientAddr', 'recipientAddress', 'destinationAddress', 'toAddress'], selected.recipient,
            'bridge_status_recipient_mismatch');
        optionalAddress(row, ['bridgeAddress', 'depositAddress', 'address'], options.address, 'bridge_status_address_mismatch');
        if (selected.wallet) optionalAddress(row, ['sourceAddress'], selected.wallet, 'bridge_status_source_mismatch');
        for (const key of ['sourceTxHash', 'sourceTransactionHash', 'originTxHash', 'fromTxHash'])
            if (row[key] !== undefined && (!validHash(row[key]) || lower(row[key]) !== lower(options.sourceHash)))
                fail('bridge_status_source_mismatch', 'bridge_status');
        if (row.status !== 'DEPOSIT_DETECTED' && row.createdTimeMs === undefined) fail('invalid_bridge_status', 'bridge_status');
        if (row.status === 'COMPLETED' ? !validHash(row.txHash) : row.txHash !== undefined)
            fail('invalid_bridge_status', 'bridge_status');
        let amountUnits, from;
        for (const key of ['toAmountBaseUnit', 'destinationAmountBaseUnit']) if (row[key] !== undefined) {
            const value = uint(row[key], true).toString();
            if (amountUnits !== undefined && amountUnits !== value) fail('bridge_status_amount_mismatch', 'bridge_status');
            amountUnits = value;
        }
        if (row.destinationFromAddress !== undefined) {
            if (!validAddress(row.destinationFromAddress)) fail('invalid_bridge_status', 'bridge_status');
            from = lower(row.destinationFromAddress);
        }
        (intermediate ? intermediates : matched).push({ status: row.status, transactionHash: row.txHash === undefined ? null : lower(row.txHash),
            createdAt: row.createdTimeMs ?? null, destinationAmountUnits: amountUnits ?? null, from: from ?? null,
            sourceHash: lower(options.sourceHash), address: lower(options.address), ...selected,
            ...(intermediate ? { sourceToken: lower(BRIDGE.intermediateToken), destinationToken: lower(BRIDGE.destinationToken) } : {}) });
    }
    if (matched.length > 1 || intermediates.length > 1) fail('ambiguous_bridge_status', 'bridge_status');
    return { match: matched[0] ?? null, intermediates, nextCursor: response.nextCursor };
}

// request follows fetch's interface. No endpoint has an automatic retry. The
// caller must persist the POST attempt before entering this method: the local
// memo only protects repeated calls in this process, including rejected calls.
export function createProfitBridge({ request = globalThis.fetch, wallet, recipient, clock = Date.now, timeoutMs = 20000 } = {}) {
    const selected = route({ wallet, recipient });
    if (!selected.wallet || typeof request !== 'function' || typeof clock !== 'function'
        || !integer(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) fail('invalid_bridge_adapter');
    const withdrawals = new Map();
    async function json(path, method = 'GET', body, stage = 'bridge_request') {
        const response = await request(`${BRIDGE.baseUrl}${path}`, { method, redirect: 'error',
            headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) });
        if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
            || typeof response.json !== 'function') {
            const httpStatus = Number.isInteger(response?.status) && response.status >= 400 && response.status <= 599
                ? response.status : undefined;
            throw new OperationalError('bridge_http_error', httpStatus >= 500 ? 'transport'
                : httpStatus === 429 ? 'rate_limit' : httpStatus ? 'api_rejection' : 'validation',
            { stage, endpoint: 'polymarket_bridge', httpStatus });
        }
        return response.json();
    }
    return {
        async supportedAssets(amountUnits = selected.amountUnits) {
            return parseBridgeAssets(await json('/supported-assets', 'GET', undefined, 'bridge_supported_assets'), { amountUnits });
        },
        async quote(options = {}) {
            const context = { ...options, ...selected, amountUnits: options.amountUnits ?? selected.amountUnits };
            const quote = parseBridgeQuote(await json('/quote', 'POST', bridgeQuoteRequest(context), 'bridge_quote'), context);
            const quotedAt = clock();
            if (!integer(quotedAt)) fail('invalid_bridge_clock');
            return { ...quote, quotedAt, expiresAt: quotedAt + 30000 };
        },
        createWithdrawal({ intentId } = {}) {
            if (typeof intentId !== 'string' || !/^[\w:-]{1,128}$/.test(intentId)) return Promise.reject(
                new OperationalError('invalid_bridge_intent', 'validation', { stage: 'bridge_withdrawal_address', endpoint: 'polymarket_bridge' }));
            if (!withdrawals.has(intentId)) withdrawals.set(intentId, (async () => {
                try { return parseBridgeWithdrawal(await json('/withdraw', 'POST', bridgeWithdrawalRequest(selected), 'bridge_withdrawal_address'), selected); }
                catch (cause) {
                    throw new OperationalError('bridge_withdrawal_creation_unknown', 'validation',
                        { stage: 'bridge_withdrawal_address', endpoint: 'polymarket_bridge', cause, ambiguous: true });
                }
            })());
            return withdrawals.get(intentId);
        },
        async status(options = {}) {
            const context = { ...options, ...selected };
            if (!validAddress(context.address) || options.cursor !== undefined
                && (typeof options.cursor !== 'string' || !options.cursor || options.cursor.length > 4096)) fail('invalid_bridge_status', 'bridge_status');
            const query = new URLSearchParams({ limit: '100' });
            if (options.cursor !== undefined) query.set('cursor', options.cursor);
            return parseBridgeStatus(await json(`/status/${lower(context.address)}?${query}`, 'GET', undefined, 'bridge_status'), context);
        },
    };
}

// canonicalBlock is independently read by the RPC caller. A provider's
// COMPLETED string or a recipient balance increase alone never proves delivery.
export function verifyBridgeDestinationReceipt({ receipt, block, canonicalBlock, expected } = {}) {
    try {
        const selected = route(expected), min = uint(expected.minOutputUnits, true), max = uint(expected.maxOutputUnits, true);
        if (min > max || max > BigInt(BRIDGE_MAX_OUTPUT_UNITS) || !validHash(expected.transactionHash)
            || !integer(block) || !receipt || receipt.status !== 1 || receipt.chainId !== undefined && receipt.chainId !== 137
            || lower(receipt.transactionHash) !== lower(expected.transactionHash) || !validHash(receipt.blockHash)
            || !integer(receipt.blockNumber) || receipt.blockNumber > block || !integer(receipt.transactionIndex)
            || !integer(receipt.confirmations) || receipt.confirmations < 2 || !Array.isArray(receipt.logs)
            || canonicalBlock?.number !== receipt.blockNumber || lower(canonicalBlock.hash) !== lower(receipt.blockHash)
            || expected.from !== undefined && expected.from !== null && !validAddress(expected.from)) return null;
        let total = 0n, previous = -1;
        const logIndexes = [], senders = new Set();
        for (const log of receipt.logs) {
            if (!validAddress(log?.address) || !integer(log.logIndex) || log.logIndex <= previous || log.removed === true
                || !Array.isArray(log.topics) || log.topics.length > 4 || log.topics.some(topic => !HASH.test(topic))
                || !HEX.test(log.data || '') || log.transactionHash !== undefined && lower(log.transactionHash) !== lower(receipt.transactionHash)
                || log.blockHash !== undefined && lower(log.blockHash) !== lower(receipt.blockHash)
                || log.blockNumber !== undefined && log.blockNumber !== receipt.blockNumber
                || log.transactionIndex !== undefined && log.transactionIndex !== receipt.transactionIndex) return null;
            previous = log.logIndex;
            if (!same(log.address, BRIDGE.destinationToken) || lower(log.topics[0]) !== transferTopic) continue;
            const args = erc20.parseLog(log).args, encoded = erc20.encodeEventLog(erc20.getEvent('Transfer'), [...args]);
            if (lower(encoded.data) !== lower(log.data) || encoded.topics.length !== log.topics.length
                || encoded.topics.some((topic, index) => lower(topic) !== lower(log.topics[index]))) return null;
            if (same(args.from, selected.recipient)) return null;
            if (!same(args.to, selected.recipient)) continue;
            if (!validAddress(args.from) || expected.from && !same(args.from, expected.from)) return null;
            const value = uint(args.value.toString(), true);
            total += value; logIndexes.push(log.logIndex); senders.add(lower(args.from));
        }
        if (!logIndexes.length || total < min || total > max
            || expected.destinationAmountUnits !== undefined && expected.destinationAmountUnits !== null
                && total !== uint(expected.destinationAmountUnits, true)) return null;
        const received = Number(total) / SCALE, scaled = received * SCALE;
        if (!Number.isSafeInteger(Math.round(scaled)) || Math.round(scaled) !== Number(total)
            || Math.abs(scaled - Math.round(scaled)) > .00001) return null;
        const difference = uint(selected.amountUnits) - total;
        return { hash: lower(receipt.transactionHash), recipient: selected.recipient, asset: 'USDC', chainId: 137,
            token: lower(BRIDGE.destinationToken), amountUnits: total.toString(), amount: received,
            feeUnits: (difference > 0n ? difference : 0n).toString(),
            ...(difference < 0n ? { conversionGainUnits: (-difference).toString() } : {}), logIndexes, senders: [...senders],
            blockNumber: receipt.blockNumber, blockHash: lower(receipt.blockHash), transactionIndex: receipt.transactionIndex };
    } catch { return null; }
}

export async function readBridgeBalances({ provider, wallet, recipient, block, blockHash } = {}) {
    const selected = route({ wallet, recipient });
    if (!provider || !selected.wallet || !integer(block) || !validHash(blockHash)) fail('invalid_bridge_balance_snapshot');
    if (Number(await provider.send('eth_chainId', [])) !== 137) fail('bridge_wrong_chain');
    const anchor = async () => {
        const value = await provider.getBlock(block);
        if (value?.number !== block || lower(value.hash) !== lower(blockHash)) fail('bridge_snapshot_block_mismatch');
    };
    await anchor();
    const recipientAccount = bridgeRecipientAccount(await provider.getCode(selected.recipient, block));
    const [source, destination] = await Promise.all([[BRIDGE.sourceToken, selected.wallet],
        [BRIDGE.destinationToken, selected.recipient]].map(async ([token, owner]) => {
        const value = await provider.call({ to: token, data: erc20.encodeFunctionData('balanceOf', [owner]) }, block);
        if (!/^0x[\da-f]{64}$/i.test(value || '')) fail('invalid_bridge_balance_snapshot');
        return uint(erc20.decodeFunctionResult('balanceOf', value)[0].toString()).toString();
    }));
    await anchor();
    return { blockNumber: block, blockHash: lower(blockHash), wallet: selected.wallet, recipient: selected.recipient,
        sourceToken: lower(BRIDGE.sourceToken), destinationToken: lower(BRIDGE.destinationToken),
        sourceBalanceUnits: source, destinationBalanceUnits: destination, recipientAccount };
}

export function verifyBridgeBalanceDeltas({ before, after, sourceAmountUnits = '5000000', destinationAmountUnits } = {}) {
    try {
        route(before);
        if (!before.wallet || !validHash(before.blockHash) || !validHash(after?.blockHash)
            || !integer(before.blockNumber) || !integer(after.blockNumber) || after.blockNumber <= before.blockNumber
            || !same(before.wallet, after.wallet) || !same(before.recipient, after.recipient)
            || !same(before.sourceToken, BRIDGE.sourceToken) || !same(after.sourceToken, BRIDGE.sourceToken)
            || !same(before.destinationToken, BRIDGE.destinationToken) || !same(after.destinationToken, BRIDGE.destinationToken)
            || uint(sourceAmountUnits, true) !== 5000000n
            || uint(before.sourceBalanceUnits) - uint(after.sourceBalanceUnits) !== uint(sourceAmountUnits, true)
            || uint(after.destinationBalanceUnits) - uint(before.destinationBalanceUnits) !== uint(destinationAmountUnits, true)) return false;
        return true;
    } catch { return false; }
}
