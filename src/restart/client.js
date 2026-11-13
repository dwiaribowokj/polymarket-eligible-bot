import { createPublicClient, createSecureClient, production, OrderSide, OrderType,
    ctfMergePositionsCall, ctfRedeemPositionsCall } from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { fetchMarketInfo, fetchTickSize } from '@polymarket/client/actions';
import { hashTypedData } from 'viem';
import { ethers } from 'ethers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ResultAsync } from '@polymarket/types';
import { round } from './math.js';
import { ReadCoordinator, OperationalError, TRANSPORT, classifyError, fetchResponse, safeError } from './network.js';
import { RpcPool } from './rpc.js';
import { BtcSignal } from './signal.js';
export { safeError } from './network.js';

export const CONTRACTS = production.contracts;
const ERC20 = ['function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)'];
const CTF = ['function balanceOf(address,uint256) view returns (uint256)',
    'function payoutDenominator(bytes32) view returns (uint256)',
    'function payoutNumerators(bytes32,uint256) view returns (uint256)',
    'function isApprovedForAll(address,address) view returns (bool)',
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)',
    'event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)'];
const SAFE = ['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)',
    'function nonce() view returns (uint256)',
    'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)',
    'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)',
    'event ExecutionFailure(bytes32 txHash,uint256 payment)', 'event ExecutionSuccess(bytes32 txHash,uint256 payment)'];
const Z = ethers.constants.AddressZero;
const units = n => Number(ethers.utils.formatUnits(n, 6));
const scope = new AsyncLocalStorage();

export function compatibleBookTick(book, tick) {
    const bookTick = Number(book.tickSize);
    if (!(tick > 0 && bookTick > tick)) return false;
    const ratio = bookTick / tick;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-7) return false;
    // A stale coarser tick field is safe only if every quoted price is legal
    // on the independently verified exchange grid. Never round book prices.
    return [...book.bids, ...book.asks].every(level => {
        const price = Number(level.price), steps = price / tick;
        return Number.isFinite(price) && price > 0 && price < 1
            && Math.abs(steps - Math.round(steps)) < 1e-7;
    });
}

export async function fetchJson(url) {
    return (await fetchResponse(url)).json();
}

export function normalizeMarket(raw) {
    const array = value => typeof value === 'string' ? JSON.parse(value) : value;
    const tokens = array(raw.clobTokenIds), outcomes = array(raw.outcomes);
    if (!raw.conditionId || !Array.isArray(tokens) || tokens.length !== 2
        || outcomes?.[0]?.toLowerCase() !== 'up' || outcomes?.[1]?.toLowerCase() !== 'down')
        throw new OperationalError('unsupported_outcomes', 'validation', { stage: 'market_discovery' });
    const tick = Number(raw.orderPriceMinTickSize), minimum = Number(raw.orderMinSize);
    const schedule = raw.feesEnabled ? raw.feeSchedule : { rate: 0, exponent: 1, takerOnly: true };
    if (!(tick > 0 && tick < 1 && minimum > 0) || !schedule
        || !Number.isFinite(schedule.rate) || schedule.rate < 0 || !Number.isFinite(schedule.exponent)
        || schedule.exponent <= 0 || typeof schedule.takerOnly !== 'boolean')
        throw new OperationalError('missing_market_constraints', 'validation', { stage: 'market_discovery' });
    const end = Date.parse(raw.endDate), open = Date.parse(raw.eventStartTime);
    if (!Number.isFinite(end) || !Number.isFinite(open) || end <= open || raw.negRisk)
        throw new OperationalError('unsupported_market', 'validation', { stage: 'market_discovery' });
    return { conditionId: raw.conditionId, slug: raw.slug, title: raw.question, description: raw.description,
        tokens: tokens.map(String), outcomes, tick, minimum, fee: schedule,
        open, end, accepting: raw.acceptingOrders === true && raw.closed !== true,
        negRisk: false, fetchedAt: Date.now() };
}

export function receiptMovements(receipt, wallet, tokens) {
    const erc20 = new ethers.utils.Interface(ERC20), ctf = new ethers.utils.Interface(CTF);
    const lower = wallet.toLowerCase();
    const holdings = tokens.map(() => 0);
    let cash = 0;
    for (const log of receipt.logs) {
        try {
            if (log.address.toLowerCase() === CONTRACTS.collateralToken.toLowerCase()) {
                const parsed = erc20.parseLog(log);
                if (parsed.name !== 'Transfer') continue;
                const sign = (parsed.args.to.toLowerCase() === lower ? 1 : 0) - (parsed.args.from.toLowerCase() === lower ? 1 : 0);
                cash += sign * units(parsed.args.value);
            } else if (log.address.toLowerCase() === CONTRACTS.conditionalTokens.toLowerCase()) {
                const parsed = ctf.parseLog(log);
                const sign = (parsed.args.to.toLowerCase() === lower ? 1 : 0) - (parsed.args.from.toLowerCase() === lower ? 1 : 0);
                const ids = parsed.name === 'TransferBatch' ? parsed.args.ids : [parsed.args.id];
                const values = parsed.name === 'TransferBatch' ? parsed.args[4] : [parsed.args.value];
                ids.forEach((id, i) => { const index = tokens.indexOf(id.toString()); if (index >= 0) holdings[index] += sign * units(values[i]); });
            }
        } catch { /* Ignore unrelated contracts and events. */ }
    }
    return { cash: round(cash), holdings: holdings.map(round) };
}

export class TradingClient {
    constructor(settings) {
        this.settings = settings;
        this.reads = new ReadCoordinator({ policy: settings.transport });
        this.reads.onEvent = event => this.onEvent?.(event);
        this.public = createPublicClient();
        this.installReads(this.public, 'public');
        if (settings.lateSignal && settings.strategies?.includes('late-entry'))
            this.btc = new BtcSignal(settings.lateSignal, event => this.onEvent?.(event));
        this.rpc = new RpcPool(settings.rpcUrls || [settings.rpcUrl], this.reads);
        this.provider = new ethers.providers.JsonRpcProvider({ url: settings.rpcUrl, timeout: TRANSPORT.timeoutMs,
            headers: { 'User-Agent': 'polymarket-reactivation/1.0' } }, { name: 'polygon', chainId: 137 });
        this.provider.pollingInterval = 2000;
        this.token = new ethers.Contract(CONTRACTS.collateralToken, ERC20, this.provider);
        this.ctf = new ethers.Contract(CONTRACTS.conditionalTokens, CTF, this.provider);
        this.secure = null;
        this.credentials = settings.credentials;
    }
    installReads(client, identity) {
        for (const [endpoint, root] of [['clob', 'https://clob.polymarket.com'],
            ['gamma', 'https://gamma-api.polymarket.com'], ['data', 'https://data-api.polymarket.com']]) {
            const service = client[endpoint];
            if (!service) continue;
            // The SDK transport has implicit GET retries. Replace only reads, retaining SDK schemas and signing.
            service.get = (path, options = {}) => {
                const url = new URL(path.replace(/^\//, ''), `${root}/`);
                if (options.params) url.search = new URLSearchParams(options.params).toString();
                const stage = /book/.test(path) ? 'book_read' : /orders|trades/.test(path) ? 'account_read' : 'metadata_read';
                const pending = this.reads.run(`${identity}:${url}`, endpoint, stage, async signal => {
                    const signedHeaders = endpoint === 'clob' ? await client.resolveClobHeaders({ method: 'GET', path, params: options.params }) : {};
                    signal.throwIfAborted();
                    const response = await fetchResponse(url, { signal, headers: { ...Object.fromEntries(new Headers(signedHeaders)),
                        ...Object.fromEntries(new Headers(options.headers)) } });
                    const body = await response.arrayBuffer();
                    return new Response(body, { status: response.status, headers: response.headers });
                }, scope.getStore());
                return ResultAsync.fromPromise(pending.then(response => response.clone()), classifyError);
            };
        }
    }
    async json(url, endpoint, stage, options = {}) {
        return this.reads.run(`${endpoint}:${url}`, endpoint, stage,
            async signal => (await fetchResponse(url, { ...options, signal })).json(), scope.getStore());
    }
    async serverTime() {
        if (!this.clock || Date.now() - this.clock.at >= TRANSPORT.clockMs) {
            this.clockPending ||= (async () => {
                const before = Date.now(), value = Number(await this.json('https://clob.polymarket.com/time', 'clob', 'server_time')) * 1000;
                const after = Date.now(), skewMs = value - (before + after) / 2;
                if (!Number.isFinite(value) || Math.abs(skewMs) > this.settings.maxClockSkewMs
                    || after - before > this.settings.maxDataAgeMs) throw new OperationalError('invalid_server_clock', 'stale_data',
                        { stage: 'server_time', durationMs: after - before });
                this.clock = { at: after, skewMs };
            })().finally(() => { this.clockPending = null; });
            await this.clockPending;
        }
        return Date.now() + this.clock.skewMs;
    }
    validateInfo(market, info) {
        if (info.negRisk || info.feeInfo.rate !== market.fee.rate || info.feeInfo.exponent !== market.fee.exponent
            || market.tokens.some((token, i) => !info.tokens.some(t => t.assetId === token && t.outcome === market.outcomes[i])))
            throw new OperationalError('metadata_mismatch', 'validation', { stage: 'metadata_read' });
    }
    async marketInfo(market) { return fetchMarketInfo(this.public, { conditionId: market.conditionId }); }
    async tickSize(assetId) { return fetchTickSize(this.public, { assetId }); }
    async market(slug, options = {}) {
        return scope.run(options, async () => {
            const market = normalizeMarket(await this.json(`https://gamma-api.polymarket.com/markets/slug/${slug}`, 'gamma', 'market_discovery'));
            const info = await this.marketInfo(market);
            this.validateInfo(market, info);
            if (!(info.tickSize > 0 && info.tickSize < 1)) throw new OperationalError('invalid_tick_size');
            if (market.tick !== info.tickSize) this.onEvent?.({ type: 'metadata_tick_updated', previous: market.tick, tick: info.tickSize });
            market.tick = info.tickSize;
            market.ticks = [info.tickSize, info.tickSize];
            if (this.btc) {
                if (!/time-weighted average price \(TWAP\)/i.test(market.description || '')
                    || !/data\.chain\.link\/streams\/btc-usd-twap-60s-streams/.test(market.description || ''))
                    throw new OperationalError('unsupported_btc_resolution_source', 'validation', { stage: 'btc_reference' });
                const opening = this.btc.openings.get(market.open);
                market.reference = opening ? { source: 'chainlink_twap_60s', open: market.open,
                    end: market.end, value: opening.value, observedAt: opening.at, receivedAt: opening.receivedAt } : null;
            }
            return market;
        });
    }
    startBtcFeed() {
        if (!this.btc || this.btcTask || this.closed || Date.now() < (this.btcRetryAt || 0)) return;
        this.btcTask = (async () => {
            // Authentication proves feed access only; this path never submits
            // orders or transactions. Do not fall back to a different source.
            const feedClient = await this.authenticate();
            const stream = await feedClient.subscribe([
                { topic: 'prices.crypto', symbols: ['btcusd'] },
                { topic: 'prices.crypto.twap', symbols: ['btcusd'] },
            ]);
            this.btcStream = stream;
            if (this.closed) { await stream.close(); return; }
            this.onEvent?.({ type: 'btc_feed_connected', source: 'chainlink_polybolt', windowSeconds: 60 });
            for await (const event of stream) this.btc.ingest(event);
        })().catch(error => {
            this.btcRetryAt = Date.now() + TRANSPORT.circuitMs;
            this.onEvent?.({ type: 'btc_feed_failed', error: safeError(error, { stage: 'btc_feed' }) });
        }).finally(() => { this.btcTask = null; });
    }
    btcStatus() { return this.btc?.status() || null; }
    assessEntry(market, order, now = Date.now()) {
        return this.btc?.assess(market, order, this.settings, now) || { reason: 'btc_feed_unavailable' };
    }
    async books(market, options = {}) {
        return scope.run(options, async () => {
            const fetchBooks = () => Promise.all(market.tokens.map(assetId => this.public.fetchOrderBook({ assetId })));
            let raw = await fetchBooks();
            const validate = rows => rows.forEach((book, i) => {
                if (book.conditionId !== market.conditionId || book.assetId !== market.tokens[i] || book.negRisk
                    || Number(book.minOrderSize) !== market.minimum) throw new OperationalError('market_constraints_changed', 'validation', { stage: 'book_read' });
            });
            validate(raw);
            const cachedTicks = market.ticks || [market.tick, market.tick];
            const verifiedLag = market.tickVerifiedAt && Date.now() - market.tickVerifiedAt < 5000
                && raw.every((book, i) => Number(book.tickSize) === cachedTicks[i] || compatibleBookTick(book, cachedTicks[i]));
            if (!verifiedLag && raw.some((book, i) => Number(book.tickSize) !== cachedTicks[i])) {
                const [info, initialTicks] = await Promise.all([
                    this.marketInfo(market),
                    Promise.all(market.tokens.map(assetId => this.tickSize(assetId))),
                ]);
                this.validateInfo(market, info);
                raw = await fetchBooks(); validate(raw);
                let ticks = initialTicks;
                if (ticks.some((tick, i) => tick !== Number(raw[i].tickSize))) {
                    this.onEvent?.({ type: 'tick_snapshot_conflict', slug: market.slug, metadataTick: info.tickSize,
                        cachedTicks: market.ticks || [market.tick, market.tick], endpointTicks: ticks,
                        bookTicks: raw.map(b => Number(b.tickSize)), bookTimestamps: raw.map(b => Number(b.timestamp)) });
                    // A tick can change while the independent endpoints are being read.
                    // Verify once more, then fail closed. Never bypass the order constraints.
                    ticks = await Promise.all(market.tokens.map(assetId => this.tickSize(assetId)));
                    raw = await fetchBooks(); validate(raw);
                }
                const lagging = ticks.some((tick, i) => tick !== Number(raw[i].tickSize));
                if (ticks.some((tick, i) => !(tick > 0 && tick < 1)
                    || tick !== Number(raw[i].tickSize) && !(tick === initialTicks[i] && compatibleBookTick(raw[i], tick))))
                    throw new OperationalError('tick_snapshot_mismatch', 'validation', { stage: 'book_read' });
                if (lagging) this.onEvent?.({ type: 'book_tick_lag_verified', slug: market.slug,
                    endpointTicks: ticks, bookTicks: raw.map(b => Number(b.tickSize)) });
                this.onEvent?.({ type: 'metadata_tick_updated', previous: market.ticks || [market.tick, market.tick], ticks });
                market.ticks = ticks;
                market.tickVerifiedAt = Date.now();
                if (ticks[0] === ticks[1]) market.tick = ticks[0];
            }
            return raw.map(book => {
                const levels = rows => rows.map(row => ({ price: Number(row.price), size: Number(row.size) }))
                    .filter(row => Number.isFinite(row.price) && row.price > 0 && row.price < 1 && Number.isFinite(row.size) && row.size > 0);
                const now = Date.now();
                const timestamp = typeof book.timestamp === 'number' || /^\d+$/.test(book.timestamp) ? Number(book.timestamp) : Date.parse(book.timestamp);
                const dataAgeMs = Math.abs(now - timestamp);
                if (!timestamp || dataAgeMs > this.settings.maxDataAgeMs) throw new OperationalError('stale_book', 'stale_data',
                    { stage: 'book_read', dataAgeMs });
                return { bids: levels(book.bids).sort((a, b) => b.price - a.price),
                    asks: levels(book.asks).sort((a, b) => a.price - b.price), fetchedAt: now, timestamp };
            });
        });
    }
    async confirmedBlock() { return this.rpc.snapshot(); }
    async balance(blockTag) {
        blockTag ??= await this.confirmedBlock();
        return this.rpc.read('wallet_balance', async (provider, block) => units(await new ethers.Contract(CONTRACTS.collateralToken,
            ERC20, provider).balanceOf(this.settings.wallet, { blockTag: block })), blockTag);
    }
    async holdings(tokens, blockTag) {
        blockTag ??= await this.confirmedBlock();
        return this.rpc.read('wallet_holdings', (provider, block) => Promise.all(tokens.map(async id => units(await
            new ethers.Contract(CONTRACTS.conditionalTokens, CTF, provider).balanceOf(this.settings.wallet, id, { blockTag: block })))),
        blockTag, `holdings:${tokens.join(',')}`);
    }
    async payout(conditionId) {
        const block = await this.confirmedBlock();
        return this.rpc.read('official_payout', async (provider, blockTag) => {
            const ctf = new ethers.Contract(CONTRACTS.conditionalTokens, CTF, provider);
            const denominator = await ctf.payoutDenominator(conditionId, { blockTag });
            if (denominator.isZero()) return null;
            const values = await Promise.all([0, 1].map(i => ctf.payoutNumerators(conditionId, i, { blockTag })));
            return values.map(value => Number(value) / Number(denominator));
        }, block, `payout:${conditionId}`);
    }
    async gasPriceUsd() {
        const now = Date.now();
        if (!this.polPrice || now - this.polPrice.at > 60000) {
            const quote = await this.json('https://api.coingecko.com/api/v3/simple/price?ids=polygon-ecosystem-token&vs_currencies=usd', 'gas_quote', 'gas_quote');
            const price = quote['polygon-ecosystem-token']?.usd;
            if (!(price > 0)) throw new Error('Missing POL/USD price');
            this.polPrice = { value: price, at: now };
        }
        return this.polPrice.value;
    }
    async authenticate() {
        if (this.secure) return this.secure;
        if (!this.settings.privateKey || !this.settings.wallet) throw new Error('Wallet configuration missing');
        const signer = privateKey(this.settings.privateKey);
        const original = signer.signTypedData.bind(signer);
        signer.signTypedData = async payload => {
            if (payload.primaryType === 'Order') this.lastOrderHash = hashTypedData(payload);
            return original(payload);
        };
        if (!this.credentials) {
            // Derive an existing API key with a GET; preflight never creates one.
            const eoa = new ethers.Wallet(this.settings.privateKey);
            const timestamp = String(Math.floor((await this.serverTime()) / 1000));
            const signature = await eoa._signTypedData({ name: 'ClobAuthDomain', version: '1', chainId: 137 },
                { ClobAuth: [{ name: 'address', type: 'address' }, { name: 'timestamp', type: 'string' },
                    { name: 'nonce', type: 'uint256' }, { name: 'message', type: 'string' }] },
                { address: eoa.address, timestamp, nonce: 0, message: 'This message attests that I control the given wallet' });
            const raw = await this.json('https://clob.polymarket.com/auth/derive-api-key', 'clob', 'authentication', {
                headers: { POLY_ADDRESS: eoa.address, POLY_SIGNATURE: signature, POLY_TIMESTAMP: timestamp, POLY_NONCE: '0' },
            });
            this.credentials = { key: raw.apiKey, secret: raw.secret, passphrase: raw.passphrase };
            if (!this.credentials.key || !this.credentials.secret || !this.credentials.passphrase) throw new Error('Invalid derived credentials');
        }
        this.secure = await createSecureClient({ wallet: this.settings.wallet, signer, credentials: this.credentials });
        this.installReads(this.secure, 'secure');
        return this.secure;
    }
    async ordersAndTrades(market) {
        const client = await this.authenticate();
        const collect = async pages => { const rows = []; for await (const page of pages) rows.push(...page.items); return rows; };
        const [orders, trades] = await Promise.all([
            collect(client.listOpenOrders(market ? { market: market.conditionId } : {})),
            collect(client.listAccountTrades(market ? { market: market.conditionId } : {})),
        ]);
        return { orders, trades };
    }
    async prepare(order) {
        const client = await this.authenticate();
        this.lastOrderHash = null;
        const signed = await client.createLimitOrder({ assetId: order.tokenId, side: order.side === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
            price: order.price, size: order.shares, postOnly: order.kind === 'maker' });
        if (order.kind !== 'maker') signed.orderType = OrderType.FAK;
        if (!this.lastOrderHash) throw new Error('Cannot identify signed order before submission');
        return { signed, orderId: this.lastOrderHash };
    }
    async post(signed) { return (await this.authenticate()).postOrder(signed); }
    async cancel(orderId) {
        const result = await (await this.authenticate()).cancelOrder({ orderId });
        if (!result.canceled?.includes(orderId) && !result.cancelled?.includes(orderId)) {
            const order = await this.secure.fetchOrder({ orderId });
            if (!['CANCELED', 'CANCELLED', 'MATCHED', 'FILLED', 'EXPIRED'].includes(order.status)) throw new Error('Cancellation unconfirmed');
        }
    }
    async order(orderId) { return (await this.authenticate()).fetchOrder({ orderId }); }
    async receipt(hash) { return this.rpc.read('transaction_receipt', provider => provider.getTransactionReceipt(hash), undefined, `receipt:${hash}`); }
    async transactionKnown(hash) { return this.rpc.read('transaction_status', provider => provider.getTransaction(hash), undefined, `transaction:${hash}`); }
    async prepareAction(position, kind, amount) {
        const call = kind === 'merge'
            ? ctfMergePositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken, position.market.conditionId,
                BigInt(Math.floor(amount * 1e6)))
            : ctfRedeemPositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken, position.market.conditionId);
        const signer = new ethers.Wallet(this.settings.privateKey, this.provider);
        const safe = new ethers.Contract(this.settings.wallet, SAFE, signer);
        const block = await this.confirmedBlock();
        const { nonce, hash } = await this.rpc.read('safe_action_prepare', async (provider, blockTag) => {
            const readSafe = new ethers.Contract(this.settings.wallet, SAFE, provider);
            const nonce = await readSafe.nonce({ blockTag });
            const hash = await readSafe.getTransactionHash(call.to, 0, call.data, 0, 0, 0, 0, Z, Z, nonce, { blockTag });
            return { nonce, hash };
        }, block);
        const sig = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(hash)));
        const signature = ethers.utils.hexConcat([sig.r, sig.s, ethers.utils.hexlify(sig.v + 4)]);
        const request = await safe.populateTransaction.execTransaction(call.to, 0, call.data, 0, 0, 0, 0, Z, Z, signature);
        const tx = await signer.populateTransaction({ ...request, gasLimit: 500000 });
        const raw = await signer.signTransaction(tx);
        return { kind, amount, hash: ethers.utils.keccak256(raw), raw, safeNonce: nonce.toString(),
            createdAt: Date.now(), status: 'prepared', polUsd: await this.gasPriceUsd() };
    }
    async broadcastAction(action) { return this.provider.sendTransaction(action.raw); }
    actionSucceeded(receipt) {
        if (receipt.status !== 1) return false;
        const iface = new ethers.utils.Interface(SAFE);
        for (const log of receipt.logs.filter(l => l.address.toLowerCase() === this.settings.wallet.toLowerCase())) {
            try { if (iface.parseLog(log).name === 'ExecutionSuccess') return true; } catch {}
        }
        return false;
    }
    receiptGas(receipt, polUsd) { return Number(ethers.utils.formatEther(receipt.gasUsed.mul(receipt.effectiveGasPrice))) * polUsd; }
    async walletHealth() {
        const wallet = this.settings.wallet;
        if (!ethers.utils.isAddress(wallet) || !this.settings.privateKey) throw new Error('Missing or invalid wallet settings');
        const signer = new ethers.Wallet(this.settings.privateKey);
        const block = await this.confirmedBlock();
        const read = (stage, task) => this.rpc.read(stage, task, block);
        const code = await read('wallet_code', (p, b) => p.getCode(wallet, b));
        const owners = await read('safe_owners', (p, b) => new ethers.Contract(wallet, SAFE, p).getOwners({ blockTag: b }));
        const threshold = await read('safe_threshold', (p, b) => new ethers.Contract(wallet, SAFE, p).getThreshold({ blockTag: b }));
        const balance = await this.balance(block);
        const gas = await read('wallet_gas', (p, b) => p.getBalance(signer.address, b));
        const approval = await read('adapter_approval', (p, b) => new ethers.Contract(CONTRACTS.conditionalTokens, CTF, p)
            .isApprovedForAll(wallet, CONTRACTS.collateralAdapter, { blockTag: b }));
        const exchangeAllowance = await read('exchange_allowance', (p, b) => new ethers.Contract(CONTRACTS.collateralToken, ERC20, p)
            .allowance(wallet, CONTRACTS.standardExchange, { blockTag: b }));
        const adapterAllowance = await read('adapter_allowance', (p, b) => new ethers.Contract(CONTRACTS.collateralToken, ERC20, p)
            .allowance(wallet, CONTRACTS.collateralAdapter, { blockTag: b }));
        const exchangeApproval = await read('exchange_approval', (p, b) => new ethers.Contract(CONTRACTS.conditionalTokens, CTF, p)
            .isApprovedForAll(wallet, CONTRACTS.standardExchange, { blockTag: b }));
        return { contract: code !== '0x', signerIsOwner: owners.some(x => x.toLowerCase() === signer.address.toLowerCase()),
            threshold: threshold.toNumber(), balance, nativeGas: Number(ethers.utils.formatEther(gas)),
            exchangeAllowance: units(exchangeAllowance), adapterAllowance: units(adapterAllowance),
            exchangeApproval, adapterApproval: approval };
    }
    async positions() {
        const rows = [];
        for await (const page of this.public.listPositions({ user: this.settings.wallet, pageSize: 100 })) rows.push(...page.items);
        return rows.map(row => ({ conditionId: row.conditionId || row.condition, tokenId: String(row.assetId || row.tokenId || row.asset || ''),
            size: Number(row.currentSize), title: row.title, redeemable: row.redeemable }));
    }
    close() {
        this.closed = true;
        this.btcStream?.close().catch(() => {});
        this.provider.removeAllListeners(); this.provider.polling = false; this.rpc.close();
    }
}
