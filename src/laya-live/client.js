import { TradingClient, CONTRACTS } from '../restart/client.js';
import { ethers } from 'ethers';
import { LayaRpcPool } from './rpc.js';
import { TRANSPORT, OperationalError, fetchResponse, classifyError } from '../restart/network.js';
import { prepareLimitOrder } from '@polymarket/client/actions';
import { OrderSide, ctfMergePositionsCall, ctfRedeemPositionsCall } from '@polymarket/client';
import { OpenOrderSchema } from '@polymarket/bindings/clob';
import { unwrap } from '@polymarket/types';
import { normalizePostRejection } from './order-errors.js';
import { profitTransferCall } from './profit-transaction.js';
import { BtcSignal } from './signal.js';

const ACTION_GAS_LIMIT = ethers.BigNumber.from(500000);
const ACTION_FEE_CEILING = ethers.utils.parseUnits('1000', 'gwei');
const CTF_HOLDINGS = ['function balanceOfBatch(address[],uint256[]) view returns (uint256[])'];
const ACTION_SAFE = new ethers.utils.Interface([
    'function nonce() view returns(uint256)',
    'function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns(bytes32)',
    'function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns(bool)',
]);
const ACTION_SAFE_FIELDS = [['to', 'address'], ['value', 'uint256'], ['data', 'bytes'], ['operation', 'uint8'],
    ['safeTxGas', 'uint256'], ['baseGas', 'uint256'], ['gasPrice', 'uint256'], ['gasToken', 'address'],
    ['refundReceiver', 'address'], ['nonce', 'uint256']].map(([name, type]) => ({ name, type }));
const quantity = (value, code) => {
    if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value)) throw new OperationalError(code);
    return ethers.BigNumber.from(value);
};
const nonceNumber = value => {
    const n = quantity(value, 'invalid_action_nonce');
    if (n.gt('9007199254740991')) throw new OperationalError('invalid_action_nonce');
    return n.toNumber();
};

export class LayaTradingClient extends TradingClient {
    constructor(settings) {
        super(settings);
        if (settings.lateSignal && settings.strategies?.includes('late-entry'))
            this.btc = new BtcSignal(settings.lateSignal, event => this.onEvent?.(event));
        this.rpc = new LayaRpcPool(settings.rpcUrls || [settings.rpcUrl], this.reads);
        this.balancePending = new Map();
    }
    async serverTime({ force = false } = {}) {
        if (force || !this.clock || Date.now() - this.clock.at >= TRANSPORT.clockMs) {
            this.clockPending ||= this.reads.run('live:server_time', 'clob', 'server_time', async signal => {
                // Each retry has its own round trip. Retry backoff and an
                // earlier timeout say nothing about this response's offset.
                const before = Date.now();
                const value = Number(await (await fetchResponse('https://clob.polymarket.com/time', { signal })).json()) * 1000;
                const after = Date.now(), durationMs = after - before, skewMs = value - (before + after) / 2;
                if (!Number.isFinite(value) || Math.abs(skewMs) > this.settings.maxClockSkewMs
                    || durationMs < 0 || durationMs > this.settings.maxDataAgeMs)
                    throw new OperationalError('invalid_server_clock', 'stale_data', { stage: 'server_time', durationMs });
                return { at: after, skewMs, durationMs };
            }).then(clock => { this.clock = clock; }).finally(() => { this.clockPending = null; });
            await this.clockPending;
        }
        return Date.now() + this.clock.skewMs;
    }
    async warmOrderMetadata(spec) {
        const client = await this.authenticate();
        const workflow = await prepareLimitOrder(client, { assetId: spec.tokenId,
            side: OrderSide.BUY, price: spec.price, size: spec.shares, postOnly: false });
        // Only read/validate metadata and construct the unsigned request.
        // The SDK calls the signer only when this step is completed, which
        // this warmup never does. Normal prepare still signs after reservation.
        try {
            const step = await workflow.next();
            if (step.done || step.value?.kind !== 'signOrder') throw new Error('metadata_warmup_unexpected_step');
        } catch (error) {
            throw classifyError(error);
        } finally { await workflow.return(); }
    }
    async post(signed) {
        try { return await super.post(signed); }
        catch (error) {
            const rejection = normalizePostRejection(error);
            if (rejection) return rejection;
            throw error;
        }
    }
    async prepareAction(position, kind, amount) {
        if (!['merge', 'redeem'].includes(kind) || !/^0x[\da-f]{64}$/i.test(position?.market?.conditionId || '')
            || position.market.negRisk === true || !Number.isFinite(amount)
            || kind === 'redeem' && amount !== 0 || kind === 'merge' && (amount <= 0
                || !Number.isSafeInteger(Math.round(amount * 1e6)) || Math.abs(amount * 1e6 - Math.round(amount * 1e6)) > .00001)
            || !ethers.utils.isAddress(this.settings.wallet)) throw new OperationalError('invalid_action_request');
        try {
            const call = kind === 'merge'
                ? ctfMergePositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken,
                    position.market.conditionId, BigInt(Math.round(amount * 1e6)))
                : ctfRedeemPositionsCall(CONTRACTS.collateralAdapter, CONTRACTS.collateralToken, position.market.conditionId);
            return await this.prepareSafeCall(call, { kind, amount });
        } catch (error) { throw classifyError(error); }
    }
    async prepareProfitTransfer(intent) {
        const { token, recipient, amount } = intent || {};
        if (typeof token !== 'string' || token.toLowerCase() !== CONTRACTS.collateralToken.toLowerCase()
            || typeof recipient !== 'string' || recipient.toLowerCase() === this.settings.wallet?.toLowerCase())
            throw new OperationalError('invalid_profit_transfer_request');
        let call;
        try { call = profitTransferCall({ token, recipient, amount }); }
        catch { throw new OperationalError('invalid_profit_transfer_request'); }
        return this.prepareSafeCall(call, { kind: 'profit_transfer', token, recipient, amount });
    }
    async prepareSafeCall(call, identity) {
        if (!call || !ethers.utils.isAddress(call.to) || call.to.toLowerCase() === ethers.constants.AddressZero
            || typeof call.data !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(call.data)
            || Object.keys(call).some(key => !['to', 'data'].includes(key)) || !ethers.utils.isAddress(this.settings.wallet)
            || !identity || !['merge', 'redeem', 'profit_transfer'].includes(identity.kind))
            throw new OperationalError('invalid_action_request');
        // Freeze the caller's intent before asynchronous reads. An in-flight
        // caller mutation must not change the call or its persisted identity.
        call = { to: call.to, data: call.data };
        identity = { ...identity };
        if (identity.kind === 'profit_transfer') {
            try {
                const expected = profitTransferCall(identity);
                if (identity.token.toLowerCase() !== CONTRACTS.collateralToken.toLowerCase()
                    || identity.recipient.toLowerCase() === this.settings.wallet.toLowerCase()
                    || expected.to.toLowerCase() !== call.to.toLowerCase() || expected.data.toLowerCase() !== call.data.toLowerCase())
                    throw new Error('invalid_profit_call');
            } catch { throw new OperationalError('invalid_action_request'); }
        }
        try {
            // Supply every transaction field explicitly. A provider-backed
            // populateTransaction would replace the chosen endpoint and use
            // ethers' fixed priority-fee fallback instead of Polygon's quote.
            const signer = new ethers.Wallet(this.settings.privateKey);
            const block = await this.confirmedBlock(), anchor = { ...this.rpc.anchor };
            const prepared = await this.rpc.read('safe_action_prepare', async (provider, blockTag) => {
                await this.rpc.validate(provider, anchor);
                const at = ethers.utils.hexValue(blockTag), zero = ethers.constants.AddressZero;
                const readSafe = async (method, args) => ACTION_SAFE.decodeFunctionResult(method,
                    await provider.send('eth_call', [{ to: this.settings.wallet,
                        data: ACTION_SAFE.encodeFunctionData(method, args) }, at]))[0];
                const [nonce, confirmed, pending, balance, priorityValue, gasValue, header] = await Promise.all([
                    readSafe('nonce', []), provider.send('eth_getTransactionCount', [signer.address, at]),
                    provider.send('eth_getTransactionCount', [signer.address, 'pending']),
                    provider.send('eth_getBalance', [signer.address, at]),
                    provider.send('eth_maxPriorityFeePerGas', []), provider.send('eth_gasPrice', []),
                    provider.getBlock(blockTag),
                ]);
                const nonceAtBlock = nonceNumber(confirmed), pendingNonce = nonceNumber(pending);
                if (pendingNonce < nonceAtBlock) throw new OperationalError('action_nonce_regressed');
                if (!header || header.number !== blockTag || header.hash !== anchor.hash)
                    throw new OperationalError('rpc_block_mismatch', 'reconciliation');
                const baseFee = header.baseFeePerGas;
                const priority = quantity(priorityValue, 'invalid_action_fee'), gasPrice = quantity(gasValue, 'invalid_action_fee');
                if (!ethers.BigNumber.isBigNumber(baseFee) || baseFee.lte(0) || priority.lte(0)
                    || priority.gt(gasPrice) || gasPrice.gt(ACTION_FEE_CEILING)) throw new OperationalError('invalid_action_fee');
                const projected = baseFee.mul(2).add(priority), maxFee = projected.gt(gasPrice) ? projected : gasPrice;
                if (maxFee.gt(ACTION_FEE_CEILING))
                    throw new OperationalError('action_fee_limit', 'validation', { stage: 'safe_action_prepare' });
                const gasBalance = quantity(balance, 'invalid_action_gas_balance'), requiredGas = ACTION_GAS_LIMIT.mul(maxFee);
                if (gasBalance.lt(requiredGas)) {
                    this.onEvent?.({ type: 'action_gas_unavailable', kind: identity.kind, blockNumber: blockTag,
                        availablePOL: ethers.utils.formatEther(gasBalance), requiredPOL: ethers.utils.formatEther(requiredGas),
                        shortfallPOL: ethers.utils.formatEther(requiredGas.sub(gasBalance)) });
                    throw new OperationalError('insufficient_action_gas', 'validation', { stage: 'safe_action_prepare' });
                }
                const args = [call.to, 0, call.data, 0, 0, 0, 0, zero, zero, nonce];
                const hash = await readSafe('getTransactionHash', args);
                const message = Object.fromEntries(ACTION_SAFE_FIELDS.map(({ name }, i) => [name, args[i]]));
                const localHash = ethers.utils._TypedDataEncoder.hash({ chainId: 137, verifyingContract: this.settings.wallet },
                    { SafeTx: ACTION_SAFE_FIELDS }, message);
                if (hash.toLowerCase() !== localHash.toLowerCase()) throw new OperationalError('action_safe_hash_mismatch', 'reconciliation');
                const endpoint = this.rpc.providers.indexOf(provider);
                if (endpoint < 0) throw new OperationalError('invalid_action_endpoint');
                return { nonce, hash, pendingNonce, priority, maxFee, endpoint };
            }, block);
            const polUsd = await this.gasPriceUsd();
            if (!Number.isFinite(polUsd) || polUsd <= 0) throw new OperationalError('invalid_action_gas_quote');
            const maxGasUsd = Math.ceil(Number(ethers.utils.formatEther(ACTION_GAS_LIMIT.mul(prepared.maxFee))) * polUsd * 1e6) / 1e6;
            if (!Number.isFinite(maxGasUsd) || maxGasUsd <= 0) throw new OperationalError('invalid_action_gas_quote');
            const sig = ethers.utils.splitSignature(await signer.signMessage(ethers.utils.arrayify(prepared.hash)));
            const signature = ethers.utils.hexConcat([sig.r, sig.s, ethers.utils.hexlify(sig.v + 4)]);
            const zero = ethers.constants.AddressZero;
            const data = ACTION_SAFE.encodeFunctionData('execTransaction', [call.to, 0, call.data, 0, 0, 0, 0, zero, zero, signature]);
            const raw = await signer.signTransaction({ to: this.settings.wallet, data, value: 0, chainId: 137, type: 2,
                nonce: prepared.pendingNonce, gasLimit: ACTION_GAS_LIMIT,
                maxFeePerGas: prepared.maxFee, maxPriorityFeePerGas: prepared.priority });
            return { ...identity, hash: ethers.utils.keccak256(raw), raw, safeNonce: prepared.nonce.toString(),
                createdAt: Date.now(), status: 'prepared', polUsd, maxGasUsd, broadcastRpcIndex: prepared.endpoint };
        } catch (error) { throw classifyError(error); }
    }
    async broadcastAction(action) {
        // This is one write to the endpoint proven during preparation. Errors
        // leave the persisted hash uncertain; failover must never resend it.
        try {
            if (!/^0x[\da-f]{64}$/i.test(action?.hash || '') || !/^0x(?:[\da-f]{2})+$/i.test(action?.raw || '')
                || ethers.utils.keccak256(action.raw).toLowerCase() !== action.hash.toLowerCase())
                throw new OperationalError('invalid_action_transaction');
            const tx = ethers.utils.parseTransaction(action.raw), signer = new ethers.Wallet(this.settings.privateKey);
            const cap = tx.maxFeePerGas || tx.gasPrice;
            if (tx.chainId !== 137 || tx.from?.toLowerCase() !== signer.address.toLowerCase()
                || tx.to?.toLowerCase() !== this.settings.wallet.toLowerCase() || !tx.value.isZero()
                || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || tx.gasLimit.lte(0) || tx.gasLimit.gt(ACTION_GAS_LIMIT)
                || !cap || cap.lte(0) || cap.gt(ACTION_FEE_CEILING)) throw new OperationalError('invalid_action_transaction');
            if (!this.rpc.anchor) await this.confirmedBlock();
            const index = action.broadcastRpcIndex ?? this.rpc.active;
            if (!Number.isInteger(index) || index < 0 || index >= this.rpc.providers.length)
                throw new OperationalError('invalid_action_endpoint');
            const provider = this.rpc.providers[index];
            await this.rpc.validate(provider, { ...this.rpc.anchor });
            const hash = await provider.send('eth_sendRawTransaction', [action.raw]);
            if (typeof hash !== 'string' || hash.toLowerCase() !== action.hash.toLowerCase())
                throw new OperationalError('action_submission_hash_mismatch', 'reconciliation');
            return { hash };
        } catch (error) { throw classifyError(error); }
    }
    async ordersAndTrades(market, { after } = {}) {
        if (after !== undefined && (typeof after !== "string" || !/^(0|[1-9]\d*)$/.test(after)
            || !Number.isSafeInteger(Number(after)) || Number(after) > Math.floor(Date.now() / 1000)))
            throw new OperationalError("invalid_account_trade_after", "validation", { stage: "account_read" });
        const client = await this.authenticate();
        const marketFilter = market ? { market: market.conditionId } : {};
        const collect = async pages => { const rows = []; for await (const page of pages) rows.push(...page.items); return rows; };
        const [orders, trades] = await Promise.all([
            collect(client.listOpenOrders(marketFilter)),
            collect(client.listAccountTrades({ ...marketFilter, ...(after !== undefined ? { after } : {}) })),
        ]);
        return { orders, trades: trades.map(trade => ({ ...trade,
            status: trade.status.replace(/^TRADE_STATUS_/, "") })) };
    }
    async order(orderId) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(orderId)) throw new OperationalError('invalid_order_id');
        const client = await this.authenticate();
        const response = await unwrap(client.secureClob.get(`/data/order/${orderId}`));
        const body = await response.json();
        if (response.status !== 200) throw new OperationalError('invalid_order_lookup');
        // The venue can forget a matched order. Absence cannot prove its
        // cancellation, fill, or settlement; those need separate evidence.
        if (body === null) throw new OperationalError('order_lookup_absent', 'reconciliation', { stage: 'account_read' });
        const parsed = OpenOrderSchema.safeParse(body);
        if (!parsed.success) throw new OperationalError('invalid_api_data', 'validation', { stage: 'account_read' });
        if (parsed.data.id.toLowerCase() !== orderId.toLowerCase())
            throw new OperationalError('order_identity_mismatch', 'reconciliation', { stage: 'account_read' });
        return parsed.data;
    }
    async cancel(orderId) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(orderId)) throw new OperationalError('invalid_order_id');
        const result = await (await this.authenticate()).cancelOrder({ orderId });
        if (result.canceled?.some(id => id.toLowerCase() === orderId.toLowerCase())
            || result.cancelled?.some(id => id.toLowerCase() === orderId.toLowerCase())) return;
        const order = await this.order(orderId);
        if (!['CANCELED', 'CANCELLED', 'MATCHED', 'FILLED', 'EXPIRED', 'UNMATCHED'].includes(order.status.toUpperCase()))
            throw new OperationalError('cancellation_unconfirmed', 'reconciliation', { stage: 'account_read' });
    }
    async listAutoRedemptions(market, since) {
        const wallet = this.settings.wallet;
        if (!/^0x[a-fA-F0-9]{40}$/.test(wallet) || !/^0x[a-fA-F0-9]{64}$/.test(market?.conditionId)
            || !Array.isArray(market.tokens) || market.tokens.length !== 2
            || market.tokens.some(token => typeof token !== 'string' || !/^\d+$/.test(token))
            || new Set(market.tokens).size !== 2 || !Number.isSafeInteger(since) || since < 0 || since > Date.now())
            throw new OperationalError('invalid_redemption_query');
        const key = JSON.stringify([wallet.toLowerCase(), market.conditionId.toLowerCase(), market.tokens, since]);
        this.redemptionCache ||= new Map(); this.redemptionPending ||= new Map();
        const cached = this.redemptionCache.get(key);
        if (cached && Date.now() - cached.at < 10000) {
            this.redemptionScan = { key, complete: cached.complete, at: cached.at };
            return [...cached.hashes];
        }
        if (!this.redemptionPending.has(key)) {
            const pending = (async () => {
                const hashes = new Set(), cursors = new Set();
                let complete = false;
                let pages = this.public.listActivity({ user: wallet, conditionId: market.conditionId,
                    type: ['REDEEM'], window: { start: Math.floor(since / 1000) }, pageSize: 50 });
                for (let count = 0; count < 3; count++) {
                    let page;
                    try { page = await pages.firstPage(); }
                    catch (error) {
                        const diagnostic = classifyError(error);
                        // An unidentified discovery read is unavailable evidence,
                        // not a failed redemption. Receipt validation stays separate.
                        if (diagnostic.code === 'request_failed' && diagnostic.category === 'unknown')
                            throw new OperationalError('redemption_activity_unavailable', 'transport',
                                { stage: 'redemption_activity', endpoint: 'data' });
                        throw error;
                    }
                    if (page.items.length > 50) throw new OperationalError('invalid_redemption_activity');
                    for (const row of page.items) {
                        if (row.type !== 'REDEEM' || row.wallet?.toLowerCase() !== wallet.toLowerCase()
                            || row.conditionId?.toLowerCase() !== market.conditionId.toLowerCase()
                            || !Number.isSafeInteger(row.timestamp) || row.timestamp > Date.now()
                            || !/^0x[a-fA-F0-9]{64}$/.test(row.transactionHash))
                            throw new OperationalError('invalid_redemption_activity');
                        if (row.timestamp >= since) hashes.add(row.transactionHash.toLowerCase());
                    }
                    if (!page.hasMore) { complete = true; break; }
                    if (!page.nextCursor || cursors.has(page.nextCursor))
                        throw new OperationalError('invalid_redemption_activity');
                    cursors.add(page.nextCursor); pages = pages.from(page.nextCursor);
                }
                const result = [...hashes];
                // Candidates only: market-level REDEEM rows do not identify
                // burned tokens. The caller must verify the receipt exactly.
                this.redemptionCache.clear();
                const at = Date.now();
                this.redemptionCache.set(key, { at, hashes: result, complete });
                this.redemptionScan = { key, at, complete };
                return result;
            })().finally(() => this.redemptionPending.delete(key));
            this.redemptionPending.set(key, pending);
        }
        return [...await this.redemptionPending.get(key)];
    }
    async verifiedReceipt(hash, block) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(hash) || !Number.isSafeInteger(block) || block < 0)
            throw new OperationalError('invalid_receipt_query');
        if (!this.rpc.anchor || this.rpc.anchor.number !== block) throw new OperationalError('rpc_snapshot_changed');
        const anchor = { ...this.rpc.anchor };
        return this.rpc.read('settlement_receipt', async provider => {
            await this.rpc.validate(provider, anchor);
            const receipt = await provider.getTransactionReceipt(hash);
            if (!receipt) return null;
            if (receipt.transactionHash?.toLowerCase() !== hash.toLowerCase())
                throw new OperationalError('receipt_identity_mismatch', 'reconciliation');
            if (!Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 || receipt.blockNumber > block
                || !Number.isSafeInteger(receipt.confirmations) || receipt.confirmations < 2) return null;
            const canonical = await provider.getBlock(receipt.blockNumber);
            if (!canonical?.hash) throw new OperationalError('rpc_missing_block', 'transport');
            if (canonical.number !== receipt.blockNumber || canonical.hash.toLowerCase() !== receipt.blockHash?.toLowerCase())
                throw new OperationalError('rpc_block_mismatch', 'reconciliation');
            return receipt;
        }, block, `settlement:${hash.toLowerCase()}`);
    }
    async payoutAtBlock(conditionId, block) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(conditionId)) throw new OperationalError('invalid_payout_query');
        return this.rpc.read('official_payout', async (provider, blockTag) => {
            const ctf = this.ctf.connect(provider), options = { blockTag };
            const denominator = await ctf.payoutDenominator(conditionId, options);
            if (denominator.isZero()) return null;
            const values = await Promise.all([0, 1].map(index => ctf.payoutNumerators(conditionId, index, options)));
            return values.map(value => Number(value) / Number(denominator));
        }, block, `payout:${conditionId}`);
    }
    async orderPresence(orderId) {
        if (!/^0x[a-fA-F0-9]{64}$/.test(orderId)) throw new OperationalError('invalid_order_id');
        const client = await this.authenticate();
        const response = await unwrap(client.secureClob.get(`/data/order/${orderId}`));
        const body = await response.json();
        // HTTP 200 null is the venue's absent-order response, not an OpenOrder.
        // It is never sufficient on its own to resolve a timed-out submission.
        if (response.status !== 200) throw new OperationalError('invalid_order_lookup');
        if (body !== null && (!body || typeof body !== 'object' || body.id?.toLowerCase() !== orderId.toLowerCase()))
            throw new OperationalError('invalid_order_lookup');
        return { found: body !== null, httpStatus: response.status };
    }
    async holdings(tokens, blockTag) {
        const ids = tokens.slice();
        blockTag ??= await this.confirmedBlock();
        return this.rpc.read('wallet_holdings', async (provider, block) => {
            if (!ids.length) return [];
            // One pinned ERC1155 read includes historical zero balances without a per-token RPC burst.
            const balances = await new ethers.Contract(CONTRACTS.conditionalTokens, CTF_HOLDINGS, provider)
                .balanceOfBatch(ids.map(() => this.settings.wallet), ids, { blockTag: block });
            if (!Array.isArray(balances) || balances.length !== ids.length)
                throw new OperationalError('invalid_holdings_batch', 'validation', { stage: 'wallet_holdings' });
            return balances.map(value => {
                if (!ethers.BigNumber.isBigNumber(value) || value.lt(0) || value.gt('9007199254740991'))
                    throw new OperationalError('invalid_holdings_balance', 'validation', { stage: 'wallet_holdings' });
                return Number(ethers.utils.formatUnits(value, 6));
            });
        }, blockTag, `holdings:${ids.join(',')}`);
    }
    async balance(blockTag) {
        const block = blockTag ?? await this.confirmedBlock();
        // A balance at an exact block/hash is immutable. Never carry it into a
        // new block or rebase the ledger to a more convenient wallet balance.
        const key = `${block}:${this.rpc.anchor?.hash}`;
        if (this.balanceCache?.key === key) return this.balanceCache.value;
        if (!this.balancePending.has(key)) {
            const pending = super.balance(block).then(value => {
                if (Number.isFinite(value)) this.balanceCache = { key, value };
                return value;
            }).finally(() => this.balancePending.delete(key));
            this.balancePending.set(key, pending);
        }
        return this.balancePending.get(key);
    }
}
