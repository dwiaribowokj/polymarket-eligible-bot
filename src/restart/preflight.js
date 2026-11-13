import { fetchJson, safeError, CONTRACTS } from './client.js';
import { marketSlug } from './strategy.js';
import { EPS } from './math.js';
import { setTimeout as delay } from 'node:timers/promises';

export async function preflight(client, settings, { publicOnly = false, owned = [], resuming = false,
    strategies = settings.strategies || ['late-entry'] } = {}) {
    const checks = [];
    if (strategies.includes('late-entry')) client.startBtcFeed?.();
    const check = async (name, scope, task) => {
        try {
            const detail = await task();
            checks.push({ name, scope, ok: true, detail }); return detail;
        } catch (err) { checks.push({ name, scope, ok: false, error: safeError(err) }); return null; }
    };
    const time = await check('server_time', 'public', async () => {
        const before = Date.now(), server = await client.serverTime(), after = Date.now();
        const skewMs = Math.abs(server - (before + after) / 2);
        if (skewMs > settings.maxClockSkewMs || after - before > settings.maxDataAgeMs) throw new Error('Clock or latency invalid');
        return { skewMs: Math.round(skewMs), roundTripMs: after - before };
    });
    await check('geoblock', 'live', async () => {
        const url = 'https://polymarket.com/api/geoblock';
        const result = client.json ? await client.json(url, 'geoblock', 'geoblock') : await fetchJson(url);
        if (result.blocked !== false) throw new Error('Trading restricted');
        return { blocked: false, country: result.country };
    });
    for (const strategy of strategies) {
        await check(strategy, 'public', async () => {
            const market = await client.market(marketSlug(strategy, settings, Date.now()));
            const books = await client.books(market);
            if (market.minimum > settings.shares + EPS) throw new Error('Minimum exceeds fixed size');
            if (!market.accepting) throw new Error('Market not accepting orders');
            return { slug: market.slug, conditionId: market.conditionId, minimum: market.minimum,
                tick: market.tick, ticks: market.ticks || [market.tick, market.tick], fee: market.fee,
                reference: market.reference || null, bestAsk: books.map(b => b.asks[0]?.price ?? null) };
        });
    }
    if (client.btc) await check('btc_feed', 'public', async () => {
        const deadline = Date.now() + 8000;
        while (!client.btcStatus()?.ready && Date.now() < deadline) await delay(100);
        const status = client.btcStatus();
        if (!status?.ready) throw new Error('BTC feed unavailable');
        return { ...status, entryHistoryRequiredSeconds: settings.lateSignal.lookbackSeconds };
    });
    let wallet = null, positions = [], account = null;
    if (!publicOnly) {
        wallet = await check('wallet_balance_allowance', 'live', async () => {
            const health = await client.walletHealth();
            // Safe operation support is restricted to the verified single-owner signer.
            if (!health.contract || !health.signerIsOwner || health.threshold !== 1) throw new Error('Unsupported Safe');
            return health;
        });
        if (wallet) {
            await check('funding', 'live', async () => {
                if (!resuming && wallet.balance < settings.capital - EPS) throw new Error('Insufficient pUSD for $20 pilot');
                if (wallet.nativeGas < 0.05) throw new Error('Insufficient Polygon gas reserve');
                return { pUSD: wallet.balance, requiredPUSD: settings.capital, nativeGas: wallet.nativeGas };
            });
            await check('approvals', 'live', async () => {
                if (wallet.exchangeAllowance < settings.entryCap || !wallet.exchangeApproval || !wallet.adapterApproval)
                    throw new Error('Missing pUSD/CTF approvals');
                return { exchangeAllowance: wallet.exchangeAllowance, exchangeApproval: wallet.exchangeApproval,
                    adapterApproval: wallet.adapterApproval };
            });
        }
        positions = (await check('legacy_positions', 'live', () => client.positions())) || [];
        account = await check('authenticated_order_trade_api', 'live', () => client.ordersAndTrades());
        if (account) {
            await check('unowned_open_orders', 'live', async () => {
                const unknown = account.orders.filter(order => !owned.includes(order.id));
                if (unknown.length) throw new Error('Unowned open orders may change wallet balance');
                return { botOrders: account.orders.length };
            });
        }
        await check('gas_quote', 'live', async () => ({ polUsd: await client.gasPriceUsd() }));
    }
    return { at: new Date().toISOString(), baseline: settings.fingerprint, node: process.versions.node,
        sdk: settings.sdk, collateral: 'pUSD', contracts: CONTRACTS, time,
        publicReady: checks.filter(c => c.scope === 'public').every(c => c.ok),
        liveReady: !publicOnly && checks.every(c => c.ok), checks,
        wallet, positions, openOrders: account?.orders.map(o => ({ id: o.id, conditionId: o.conditionId })) || [] };
}
