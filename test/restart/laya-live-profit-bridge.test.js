import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { OperationalError, safeError } from '../../src/restart/network.js';
import { BRIDGE, BRIDGE_MAX_OUTPUT_UNITS, bridgeRecipientAccount, bridgeQuoteRequest, bridgeWithdrawalRequest, parseBridgeAssets, parseBridgeQuote,
    parseBridgeWithdrawal, parseBridgeStatus, createProfitBridge, assertBridgeQuoteFresh,
    verifyBridgeDestinationReceipt, readBridgeBalances, verifyBridgeBalanceDeltas } from '../../src/laya-live/profit-bridge.js';

const wallet = `0x${'1'.repeat(40)}`, recipient = `0x${'2'.repeat(40)}`, deposit = `0x${'3'.repeat(40)}`;
const payout = `0x${'4'.repeat(40)}`, another = `0x${'5'.repeat(40)}`, hash = char => `0x${char.repeat(64)}`;
const sourceHash = hash('a'), destinationHash = hash('b'), blockHash = hash('c');
const context = { wallet, recipient, amountUnits: '5000000', maxFeeUsd: .05, maxSlippagePercent: 0 };
const statusContext = { ...context, address: deposit, sourceHash, createdAt: 1000 };
const erc20 = new ethers.utils.Interface(['function balanceOf(address owner) view returns(uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)']);
function quote(overrides = {}) {
    return { estCheckoutTimeMs: 27000, estInputUsd: 4.9995, estOutputUsd: 4.999395,
        estToTokenBaseUnit: '4999960', quoteId: hash('d'), estFeeBreakdown: {
            appFeeLabel: 'Swap fee', appFeePercent: 0, appFeeUsd: 0, fillCostPercent: 0, fillCostUsd: 0,
            gasUsd: .024682, maxSlippage: 0, minReceived: 4.999395, swapImpact: .0021002100210021,
            swapImpactUsd: .000105, totalImpact: .0021002100210021, totalImpactUsd: .000105,
        }, ...overrides };
}
function assets() {
    return { supportedAssets: [BRIDGE.sourceToken, BRIDGE.destinationToken].map(address => ({ chainId: '137',
        token: { address, decimals: 6 }, minCheckoutUsd: 2 })) };
}
function status(overrides = {}) {
    return { fromChainId: '137', fromTokenAddress: BRIDGE.sourceToken, fromAmountBaseUnit: '5000000',
        toChainId: '137', toTokenAddress: BRIDGE.destinationToken, status: 'COMPLETED',
        txHash: destinationHash, createdTimeMs: 1500, ...overrides };
}
function transfer(from, to, amount, index, address = BRIDGE.destinationToken) {
    return { address, logIndex: index, ...erc20.encodeEventLog(erc20.getEvent('Transfer'), [from, to, amount]) };
}
function receipt(logs = [transfer(payout, recipient, '4999960', 3)]) {
    return { transactionHash: destinationHash, blockNumber: 100, blockHash, confirmations: 3,
        transactionIndex: 2, status: 1, logs };
}
function proof(value = receipt(), expected = {}, overrides = {}) {
    return verifyBridgeDestinationReceipt({ receipt: value, block: 101, canonicalBlock: { number: 100, hash: blockHash },
        expected: { ...context, transactionHash: destinationHash, minOutputUnits: '4950000',
            maxOutputUnits: '5000000', ...expected }, ...overrides });
}
const response = data => ({ status: 200, async json() { return data; } });

test('recipient account accepts empty EOA code and strict EIP-7702 delegation without accepting arbitrary contracts', () => {
    assert.deepEqual(bridgeRecipientAccount('0x'), { kind: 'eoa', delegate: null });
    const actual = '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b';
    assert.deepEqual(bridgeRecipientAccount(actual), { kind: 'delegated_eoa', delegate: '0x63c0c19a282a1b52b07dd5a65b58948a07dae32b' });
    for (const code of ['0x1234', `${actual}00`, actual.slice(0, -2), `0xef0100${'0'.repeat(40)}`,
        `0xef0101${'1'.repeat(40)}`, undefined, null]) assert.throws(() => bridgeRecipientAccount(code), /bridge_recipient_not_eoa/);
});

test('route requests pin Polygon pUSD input, native USDC output and the authorized recipient', () => {
    assert.deepEqual(bridgeQuoteRequest({ ...context, fromChainId: '1', toTokenAddress: another }), {
        fromAmountBaseUnit: '5000000', fromChainId: '137', fromTokenAddress: BRIDGE.sourceToken,
        recipientAddress: recipient, toChainId: '137', toTokenAddress: BRIDGE.destinationToken });
    assert.deepEqual(bridgeWithdrawalRequest(context), { address: wallet, toChainId: '137',
        toTokenAddress: BRIDGE.destinationToken, recipientAddr: recipient });
    for (const invalid of [{ recipient: wallet }, { recipient: ethers.constants.AddressZero }, { amountUnits: '5000001' },
        { recipient: BRIDGE.sourceToken }]) assert.throws(() => bridgeQuoteRequest({ ...context, ...invalid }));
});

test('supported asset minimums, network, decimals and unique token entries must be known', () => {
    assert.equal(parseBridgeAssets(assets()).minimumUsd, 2);
    for (const mutate of [value => { value.supportedAssets[1].token.decimals = 18; },
        value => { value.supportedAssets[1].minCheckoutUsd = null; },
        value => { value.supportedAssets[1].minCheckoutUsd = 6; },
        value => { value.supportedAssets[1].chainId = '1'; },
        value => { value.supportedAssets.push(value.supportedAssets[1]); }]) {
        const value = assets(); mutate(value); assert.throws(() => parseBridgeAssets(value));
    }
});

test('live-shaped quote retains valuation differences, explicit gas and all fee fields', () => {
    const value = parseBridgeQuote(quote(), context);
    assert.equal(value.estimatedOutputUnits, '4999960'); assert.equal(value.minOutputUnits, '4950000');
    assert.equal(value.maxOutputUnits, '5000000'); assert.equal(value.gasReserveUsd, .024682);
    assert.equal(value.fees.minReceived, 4.999395); assert.equal(value.estimatedCostUsd, .024787);
    assert.equal(value.fees.totalImpactUsd, .000105);
    assert.throws(() => parseBridgeQuote(quote(), { ...context, maxFeeUsd: undefined }), /invalid_bridge_fee_cap/);
    for (const key of Object.keys(quote().estFeeBreakdown).filter(key => key !== 'appFeeLabel')) {
        const signed = ['swapImpact', 'swapImpactUsd', 'totalImpact', 'totalImpactUsd'].includes(key);
        for (const invalid of [undefined, null, '0', NaN, Infinity, ...(signed ? [] : [-1])]) {
            const value = quote(); value.estFeeBreakdown[key] = invalid;
            assert.throws(() => parseBridgeQuote(value, context), /invalid_bridge_quote/, `${key}: ${invalid}`);
        }
    }
});

test('quote admission rejects excessive gas, price shortfall, slippage and invalid output units', () => {
    for (const mutate of [value => { value.estFeeBreakdown.gasUsd = .050001; },
        value => { value.estToTokenBaseUnit = '4949999'; }, value => { value.estToTokenBaseUnit = '9007199254740992'; },
        value => { value.estFeeBreakdown.maxSlippage = .01; }, value => { value.estToTokenBaseUnit = '4.99'; }]) {
        const value = quote(); mutate(value); assert.throws(() => parseBridgeQuote(value, context));
    }
});

test('favorable native-USDC conversion accepts the observed 5000121-unit quote without hiding fees', () => {
    const response = { estCheckoutTimeMs: 27000, estInputUsd: 4.998505, estOutputUsd: 4.998261,
        estToTokenBaseUnit: '5000121', quoteId: hash('d'), estFeeBreakdown: {
            appFeeLabel: 'Swap fee', appFeePercent: 0, appFeeUsd: 0, fillCostPercent: 0, fillCostUsd: 0,
            gasUsd: .025226, maxSlippage: 0, minReceived: 4.998261, swapImpact: .004881459556407366,
            swapImpactUsd: .00024399999999999997, totalImpact: .004881459556407366, totalImpactUsd: .000244 } };
    const parsed = parseBridgeQuote(response, context);
    assert.equal(parsed.estimatedOutputUnits, '5000121');
    assert.equal(parsed.maxOutputUnits, '5000121');
    assert.equal(parsed.minOutputUnits, '4950000');
    assert.ok(Math.abs(parsed.estimatedCostUsd - .025470) < 1e-12);
    assert.equal(parsed.amountUnits, '5000000');
});

test('signed impact metadata never offsets actual positive provider charges in the fee cap', () => {
    const favorable = quote({ estToTokenBaseUnit: '5000121' });
    Object.assign(favorable.estFeeBreakdown, { swapImpact: -.1, swapImpactUsd: -.005,
        totalImpact: -.1, totalImpactUsd: -.005, appFeeUsd: .02, fillCostUsd: .01, gasUsd: .01 });
    const parsed = parseBridgeQuote(favorable, context);
    assert.equal(parsed.estimatedCostUsd, .04);
    assert.equal(parsed.fees.swapImpactUsd, -.005);
    assert.equal(parsed.fees.totalImpactUsd, -.005);
    favorable.estFeeBreakdown.appFeeUsd = .04;
    assert.throws(() => parseBridgeQuote(favorable, context), /bridge_quote_exceeds_budget/);
});

test('quote expires at thirty seconds and cannot be reused for a changed wallet or recipient', async () => {
    const bridge = createProfitBridge({ ...context, clock: () => 1000, request: async () => response(quote()) });
    const value = await bridge.quote({ maxFeeUsd: .05, maxSlippagePercent: 0 });
    assert.equal(value.expiresAt, 31000);
    assert.equal(assertBridgeQuoteFresh(value, { ...context, now: 30999 }), true);
    for (const options of [{ now: 31000 }, { now: 999 }, { now: 1100, recipient: another },
        { now: 1100, wallet: another }, { now: 1100, maxAgeMs: 60000 }])
        assert.throws(() => assertBridgeQuoteFresh(value, { ...context, ...options }), /bridge_quote_expired_or_mismatched/);
});

test('withdrawal address is exact EVM address and cannot route back into own wallets or token contracts', () => {
    assert.equal(parseBridgeWithdrawal({ address: { evm: deposit } }, context).address, deposit);
    for (const address of [wallet, recipient, ethers.constants.AddressZero, BRIDGE.sourceToken, BRIDGE.destinationToken, 'abc'])
        assert.throws(() => parseBridgeWithdrawal({ address: { evm: address } }, context));
});

test('withdraw POST is called exactly once for an intent including concurrent calls and timeout', async () => {
    const calls = [];
    const bridge = createProfitBridge({ ...context, request: async (url, options) => {
        calls.push({ url, options }); throw new Error('timeout');
    } });
    const a = bridge.createWithdrawal({ intentId: 'withdrawal:1' }), b = bridge.createWithdrawal({ intentId: 'withdrawal:1' });
    assert.equal(a, b);
    await assert.rejects(a, error => error.code === 'bridge_withdrawal_creation_unknown' && error.ambiguous === true);
    await assert.rejects(bridge.createWithdrawal({ intentId: 'withdrawal:1' }), /bridge_withdrawal_creation_unknown/);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, `${BRIDGE.baseUrl}/withdraw`);
    assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error');
    assert.deepEqual(JSON.parse(calls[0].options.body), bridgeWithdrawalRequest(context));
});

test('malformed success or HTTP failure remains an ambiguous withdrawal creation with no retry', async () => {
    for (const output of [response({ address: { svm: 'unrelated' } }), { status: 500, json: async () => ({}) }]) {
        let calls = 0;
        const bridge = createProfitBridge({ ...context, request: async () => { calls++; return output; } });
        await assert.rejects(bridge.createWithdrawal({ intentId: 'one' }), /bridge_withdrawal_creation_unknown/);
        await assert.rejects(bridge.createWithdrawal({ intentId: 'one' }), /bridge_withdrawal_creation_unknown/);
        assert.equal(calls, 1);
    }
});

test('status needs exact route, amount, timing and one matching row; completed alone is only discovery', () => {
    const value = parseBridgeStatus({ transactions: [status()], nextCursor: null }, statusContext);
    assert.equal(value.match.transactionHash, destinationHash); assert.equal(value.match.destinationAmountUnits, null);
    assert.equal(value.match.amountUnits, '5000000'); assert.equal(value.match.recipient, recipient);
    assert.equal(parseBridgeStatus({ transactions: [], nextCursor: 'opaque+/=' }, statusContext).match, null);
    assert.equal(parseBridgeStatus({ transactions: [status({ createdTimeMs: 999 })], nextCursor: null }, statusContext).match, null);
    assert.throws(() => parseBridgeStatus({ transactions: [status(), status()], nextCursor: null }, statusContext), /ambiguous_bridge_status/);
    for (const changed of [{ fromChainId: '1' }, { toChainId: '1' }, { fromAmountBaseUnit: '4999999' },
        { toTokenAddress: BRIDGE.sourceToken }, { fromTokenAddress: BRIDGE.destinationToken }, { recipientAddress: another },
        { depositAddress: another }, { sourceTxHash: hash('f') }, { status: 'COMPLETED', txHash: undefined },
        { status: 'PROCESSING', createdTimeMs: undefined, txHash: undefined }])
        assert.throws(() => parseBridgeStatus({ transactions: [status(changed)], nextCursor: null }, statusContext));
    assert.throws(() => parseBridgeStatus({ transactions: [status()] }, statusContext), /invalid_bridge_status/);
});

test('status validates optional destination sender and output amount and safely encodes opaque cursor', async () => {
    let requested;
    const bridge = createProfitBridge({ ...context, request: async (url, options) => {
        requested = { url, options };
        return response({ transactions: [status({ destinationFromAddress: payout, toAmountBaseUnit: '4999960',
            sourceTxHash: sourceHash, recipientAddress: recipient, depositAddress: deposit })], nextCursor: null });
    } });
    const value = await bridge.status({ ...statusContext, cursor: 'opaque+/=' });
    assert.equal(value.match.from, payout); assert.equal(value.match.destinationAmountUnits, '4999960');
    assert.equal(new URL(requested.url).searchParams.get('cursor'), 'opaque+/=');
    assert.equal(requested.options.method, 'GET');
});

test('live-shaped status keeps pUSD and exact USDC.e operation identifiers separate in either order', () => {
    const primary = status(), intermediate = status({ fromTokenAddress: BRIDGE.intermediateToken,
        txHash: hash('e'), createdTimeMs: 1600 });
    for (const transactions of [[primary, intermediate], [intermediate, primary]]) {
        const value = parseBridgeStatus({ transactions, nextCursor: null }, statusContext);
        assert.equal(value.match.transactionHash, destinationHash);
        assert.equal(value.intermediates.length, 1);
        assert.equal(value.intermediates[0].transactionHash, hash('e'));
        assert.equal(value.intermediates[0].sourceToken, BRIDGE.intermediateToken.toLowerCase());
        assert.equal(value.intermediates[0].destinationToken, BRIDGE.destinationToken.toLowerCase());
        assert.equal(value.intermediates[0].address, deposit);
        assert.equal(value.intermediates[0].amountUnits, '5000000');
    }
    const onlyIntermediate = parseBridgeStatus({ transactions: [intermediate], nextCursor: null }, statusContext);
    assert.equal(onlyIntermediate.match, null, 'An intermediate operation cannot become the primary withdrawal');
    assert.equal(onlyIntermediate.intermediates.length, 1);
    assert.deepEqual(parseBridgeStatus({ transactions: [primary], nextCursor: null }, statusContext).intermediates, []);
});

test('USDC.e discovery retains every route and optional identity check', () => {
    const intermediate = status({ fromTokenAddress: BRIDGE.intermediateToken, txHash: hash('e'),
        sourceTxHash: sourceHash, sourceAddress: wallet, recipientAddress: recipient, depositAddress: deposit });
    for (const changed of [{ fromChainId: '1' }, { toChainId: '1' }, { fromAmountBaseUnit: '4999999' },
        { toTokenAddress: BRIDGE.intermediateToken }, { fromTokenAddress: BRIDGE.destinationToken },
        { recipientAddr: another }, { recipientAddress: another }, { destinationAddress: another }, { toAddress: another },
        { bridgeAddress: another }, { depositAddress: another }, { address: another }, { sourceAddress: another },
        { sourceTxHash: hash('f') }, { sourceTransactionHash: hash('f') }, { originTxHash: hash('f') }, { fromTxHash: hash('f') }]) {
        assert.throws(() => parseBridgeStatus({ transactions: [status(), { ...intermediate, ...changed }], nextCursor: null },
            statusContext), error => error instanceof OperationalError && error.category === 'validation', JSON.stringify(changed));
    }
    for (const changed of [{ status: 'UNKNOWN' }, { txHash: 'invalid' }, { createdTimeMs: undefined },
        { destinationFromAddress: 'invalid' }, { toAmountBaseUnit: '5000000', destinationAmountBaseUnit: '4999999' }]) {
        assert.throws(() => parseBridgeStatus({ transactions: [status(), { ...intermediate, ...changed }], nextCursor: null },
            statusContext), JSON.stringify(changed));
    }
});

test('status rejects ambiguity within either operation kind and never accepts another input token', () => {
    const primary = status(), intermediate = status({ fromTokenAddress: BRIDGE.intermediateToken, txHash: hash('e') });
    for (const transactions of [[primary, primary, intermediate], [primary, intermediate, intermediate], [intermediate, intermediate]]) {
        assert.throws(() => parseBridgeStatus({ transactions, nextCursor: null }, statusContext),
            error => error.code === 'ambiguous_bridge_status');
    }
    assert.throws(() => parseBridgeStatus({ transactions: [primary, status({ fromTokenAddress: another })], nextCursor: null },
        statusContext), error => error.code === 'bridge_status_identity_mismatch');
});

test('bridge domain diagnostics retain safe codes and status stages without arbitrary error text', async () => {
    let mismatch;
    try { parseBridgeStatus({ transactions: [status({ recipientAddress: another })], nextCursor: null }, statusContext); }
    catch (error) { mismatch = error; }
    assert.deepEqual(safeError(mismatch), { name: 'OperationalError', code: 'bridge_status_recipient_mismatch',
        category: 'validation', stage: 'bridge_status', endpoint: 'polymarket_bridge' });
    const bridge = createProfitBridge({ ...context, request: async () => ({ status: 503,
        json: async () => ({ error: 'private provider response' }) }) });
    await assert.rejects(bridge.status(statusContext), error => {
        assert.deepEqual(safeError(error), { name: 'OperationalError', code: 'bridge_http_error', category: 'transport',
            stage: 'bridge_status', endpoint: 'polymarket_bridge', httpStatus: 503 });
        return true;
    });
    await assert.rejects(bridge.createWithdrawal({ intentId: 'one' }), error => {
        const diagnostic = safeError(error);
        assert.equal(diagnostic.code, 'bridge_withdrawal_creation_unknown');
        assert.equal(diagnostic.stage, 'bridge_withdrawal_address');
        assert.equal(error.ambiguous, true);
        assert.equal(JSON.stringify(diagnostic).includes('private'), false);
        return true;
    });
});

test('destination proof aggregates exact USDC delivery, verifies sender and derives the actual shortfall', () => {
    const value = proof(receipt([transfer(payout, recipient, '2000000', 3),
        transfer(payout, another, '9000000', 4), transfer(payout, recipient, '2999960', 5)]),
    { from: payout, destinationAmountUnits: '4999960' });
    assert.equal(value.amountUnits, '4999960'); assert.equal(value.amount, 4.99996); assert.equal(value.feeUnits, '40');
    assert.deepEqual(value.logIndexes, [3, 5]); assert.deepEqual(value.senders, [payout]);
    assert.equal(proof(receipt(), { from: another }), null);
    assert.equal(proof(receipt(), { destinationAmountUnits: '4999959' }), null);
    assert.equal(proof(receipt([transfer(payout, recipient, '4949999', 3)])), null);
    assert.equal(proof(receipt([transfer(payout, recipient, '5000001', 3)])), null);
    assert.equal(proof(receipt([transfer(payout, recipient, '4999960', 3, BRIDGE.sourceToken)])), null);
    assert.equal(proof(receipt([transfer(payout, recipient, '4999960', 3), transfer(recipient, another, '1', 4)])), null);
});

test('favorable delivery proof retains exact identity and safe micro-unit bounds', () => {
    const expected = { from: payout, destinationAmountUnits: '5000121', maxOutputUnits: BRIDGE_MAX_OUTPUT_UNITS };
    const value = receipt([transfer(payout, recipient, '5000121', 3)]);
    const result = proof(value, expected);
    assert.equal(result.amount, 5.000121);
    assert.equal(result.amountUnits, '5000121');
    assert.equal(result.feeUnits, '0');
    assert.equal(result.conversionGainUnits, '121');
    assert.equal(proof(value, { ...expected, from: another }), null);
    assert.equal(proof(value, { ...expected, destinationAmountUnits: '5000122' }), null);
    assert.equal(proof(receipt([transfer(payout, recipient, '5000121', 3, BRIDGE.sourceToken)]), expected), null);
    assert.equal(proof(receipt([transfer(payout, recipient, '9007199254740992', 3)]),
        { maxOutputUnits: BRIDGE_MAX_OUTPUT_UNITS }), null);
    assert.equal(proof(receipt([transfer(payout, recipient, BRIDGE_MAX_OUTPUT_UNITS, 3)]),
        { maxOutputUnits: BRIDGE_MAX_OUTPUT_UNITS }), null, 'Micro-units must round trip through accounting numbers');
});

test('destination proof rejects noncanonical, reverted, mismatched and duplicated log evidence', () => {
    for (const change of [{ status: 0 }, { confirmations: 1 }, { transactionHash: sourceHash }, { blockHash: hash('e') },
        { chainId: 1 }, { blockNumber: 102 }, { transactionIndex: -1 }])
        assert.equal(proof({ ...receipt(), ...change }), null, JSON.stringify(change));
    for (const change of [{ removed: true }, { logIndex: -1 }, { transactionHash: sourceHash },
        { blockHash: hash('e') }, { blockNumber: 99 }, { transactionIndex: 3 }, { data: '0x01' }]) {
        const value = receipt(); Object.assign(value.logs[0], change); assert.equal(proof(value), null);
    }
    const duplicate = receipt(); duplicate.logs.push(duplicate.logs[0]); assert.equal(proof(duplicate), null);
    assert.equal(proof(receipt(), {}, { canonicalBlock: undefined }), null);
    assert.equal(proof(receipt(), {}, { canonicalBlock: { number: 100, hash: hash('e') } }), null);
});

test('balance reads pin both assets to one chain and one canonical block before and after all calls', async () => {
    const calls = [], provider = {
        async send(method) { assert.equal(method, 'eth_chainId'); return '0x89'; },
        async getCode(address, block) { assert.equal(address, recipient); assert.equal(block, 99); return '0x'; },
        async getBlock(block) { calls.push(['block', block]); return { number: 99, hash: blockHash }; },
        async call(tx, block) {
            calls.push(['call', tx.to, block]);
            const expectedOwner = tx.to === BRIDGE.sourceToken ? wallet : recipient;
            assert.equal(erc20.decodeFunctionData('balanceOf', tx.data)[0].toLowerCase(), expectedOwner);
            return erc20.encodeFunctionResult('balanceOf', [tx.to === BRIDGE.sourceToken ? '30000000' : '9935182']);
        },
    };
    const value = await readBridgeBalances({ provider, wallet, recipient, block: 99, blockHash });
    assert.equal(value.sourceBalanceUnits, '30000000'); assert.equal(value.destinationBalanceUnits, '9935182');
    assert.deepEqual(calls, [['block', 99], ['call', BRIDGE.sourceToken, 99], ['call', BRIDGE.destinationToken, 99], ['block', 99]]);
    await assert.rejects(readBridgeBalances({ provider: { ...provider, send: async () => '0x1' }, wallet, recipient,
        block: 99, blockHash }), /bridge_wrong_chain/);
    await assert.rejects(readBridgeBalances({ provider: { ...provider, getCode: async () => '0x1234' }, wallet, recipient,
        block: 99, blockHash }), /bridge_recipient_not_eoa/);
    let anchors = 0;
    await assert.rejects(readBridgeBalances({ provider: { ...provider, getBlock: async () => ({ number: 99,
        hash: ++anchors === 1 ? blockHash : hash('e') }) }, wallet, recipient, block: 99, blockHash }), /bridge_snapshot_block_mismatch/);
});

test('source debit and destination receipt amount must agree with the same before/after snapshots', () => {
    const before = { wallet, recipient, blockNumber: 90, blockHash: hash('a'), sourceToken: BRIDGE.sourceToken,
        destinationToken: BRIDGE.destinationToken, sourceBalanceUnits: '30000000', destinationBalanceUnits: '9935182' };
    const after = { ...before, blockNumber: 100, blockHash, sourceBalanceUnits: '25000000', destinationBalanceUnits: '14935142' };
    const args = { before, after, sourceAmountUnits: '5000000', destinationAmountUnits: '4999960' };
    assert.equal(verifyBridgeBalanceDeltas(args), true);
    for (const change of [{ sourceBalanceUnits: '25000001' }, { destinationBalanceUnits: '14935143' },
        { destinationToken: BRIDGE.sourceToken }, { recipient: another }, { blockNumber: 90 }])
        assert.equal(verifyBridgeBalanceDeltas({ ...args, after: { ...after, ...change } }), false);
});
