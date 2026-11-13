import { AsyncLocalStorage } from 'node:async_hooks';
import { RpcPool, RpcProvider } from '../restart/rpc.js';
import { TRANSPORT, OperationalError, classifyError } from '../restart/network.js';
import { safeError } from './network.js';

const liveReadContext = new AsyncLocalStorage();

const READ_ONLY_RPC_METHODS = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getBlockByNumber',
    'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_call',
    'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getLogs']);

function readRejectionReason(error, method) {
    const pending = [error], codes = [], messages = [];
    let revertData = false;
    // Inspect only bounded error fields; raw provider messages/data never leave
    // this classifier or become diagnostic metadata.
    for (let index = 0; index < pending.length && index < 8; index++) {
        const item = pending[index];
        if (!item || typeof item !== 'object') continue;
        codes.push(item.code);
        if (typeof item.message === 'string') messages.push(item.message.slice(0, 1024).toLowerCase());
        if (method === 'eth_call' && typeof item.data === 'string' && /^0x[0-9a-f]{8,}$/i.test(item.data))
            revertData = true;
        for (const nested of [item.error, item.originalError, item.data])
            if (nested && typeof nested === 'object' && !pending.includes(nested)) pending.push(nested);
    }
    const message = messages.join(' ');
    if (revertData || codes.includes(3) || /\brevert(?:ed)?\b|invalid opcode|out of gas|vm (?:exception|execution error)/.test(message))
        return 'execution_reverted';
    if (codes.includes(-32700) || codes.includes(-32600)) return 'invalid_request';
    if (codes.includes(-32602) || /invalid (?:params|parameters|argument)|missing (?:required )?(?:argument|parameter)/.test(message))
        return 'invalid_params';
    if (codes.includes(-32601) || /method (?:not found|not supported|not available|is not available)|unsupported method/.test(message))
        return 'method_unavailable';
    if (/unauthori[sz]ed|forbidden|access denied|invalid (?:api[ _-]?key|project id)|(?:api[ _-]?key|project id).*(?:invalid|required)|authentication (?:failed|required)/.test(message))
        return 'authentication';
    if (method === 'eth_getLogs' && codes.includes(35)
        && /\branges over [1-9]\d* blocks are not supported on free plan\b/.test(message))
        return 'log_range_limit';
    if (codes.includes(-32005) || codes.includes(429) || /rate[ -]?limit|too many requests|requests per second|quota exceeded/.test(message))
        return 'rate_limit';
    if (/header not found|(?:block|state) (?:is )?(?:not found|unavailable|not available)|missing trie node|pruned|block.*could not be found/.test(message))
        return 'block_unavailable';
    if (codes.includes(-32603)) return 'internal_error';
    if (codes.includes(-32002) || /timeout|timed out|temporarily unavailable|service unavailable|upstream|gateway|overload|try again|server error/.test(message))
        return 'upstream_unavailable';
    return 'unknown';
}

export class LayaRpcProvider extends RpcProvider {
    constructor(url, forbiddenCooldownMs = TRANSPORT.circuitMs) {
        super(url); this.forbiddenCooldownMs = forbiddenCooldownMs;
    }
    rpcError(error, method) {
        if (!READ_ONLY_RPC_METHODS.has(method)) return new OperationalError(
            error?.code === -32005 ? 'rate_limited' : 'rpc_rejected',
            error?.code === -32005 ? 'rate_limit' : 'contract');
        const rpcReason = readRejectionReason(error, method);
        const detail = { rpcMethod: method, rpcReason,
            ...(Number.isSafeInteger(error?.code) ? { rpcCode: error.code } : {}) };
        if (rpcReason === 'execution_reverted') return new OperationalError('rpc_rejected', 'contract', detail);
        if (['invalid_request', 'invalid_params', 'method_unavailable'].includes(rpcReason))
            return new OperationalError('rpc_rejected', 'validation', detail);
        if (rpcReason === 'authentication') return new OperationalError('rpc_rejected', 'api_rejection', detail);
        if (rpcReason === 'log_range_limit') return new OperationalError('rpc_log_range_unavailable', 'transport',
            { ...detail, retryAfter: this.forbiddenCooldownMs / 1000 });
        if (rpcReason === 'rate_limit') return new OperationalError('rate_limited', 'rate_limit', detail);
        // An unrecognized read rejection proves neither bad contract execution
        // nor a valid result. Existing bounded failover/circuit rules apply.
        return new OperationalError('rpc_read_rejected', 'transport', detail);
    }
    async send(method, params) {
        try {
            const response = await fetch(this.connection.url, { method: 'POST',
                signal: liveReadContext.getStore() || AbortSignal.timeout(TRANSPORT.timeoutMs),
                headers: { 'User-Agent': 'polymarket-reactivation/1.0', 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }) });
            if (!response.ok) {
                const header = response.headers.get('retry-after');
                const retryAfter = header === null ? undefined : /^\d+(\.\d+)?$/.test(header) ? Number(header)
                    : Math.max(0, (Date.parse(header) - Date.now()) / 1000);
                // Some providers return their log-range capability error as
                // HTTP 400. Only that identified read failure allows failover.
                if (method === 'eth_getLogs' && response.status === 400) {
                    let body;
                    try { body = await response.json(); }
                    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
                    const error = body?.error && this.rpcError(body.error, method);
                    if (error?.rpcReason === 'log_range_limit') {
                        error.httpStatus = 400;
                        error.retryAfter = Math.max(retryAfter || 0, error.retryAfter);
                        throw error;
                    }
                }
                throw classifyError({ status: response.status, retryAfter });
            }
            const raw = await response.json();
            if (raw.error) throw this.rpcError(raw.error, method);
            if (!Object.hasOwn(raw, 'result')) throw new OperationalError('invalid_rpc_response');
            return raw.result;
        }
        catch (error) {
            const e = classifyError(error);
            if (READ_ONLY_RPC_METHODS.has(method) && e.code === 'http_rejected'
                && e.category === 'api_rejection' && e.httpStatus === 403) {
                // This endpoint rejected a read. Try a validated backup and
                // cool down this endpoint even when every candidate fails.
                throw new OperationalError('rpc_endpoint_forbidden', 'transport', { httpStatus: 403,
                    retryAfter: Math.max(e.retryAfter || 0, this.forbiddenCooldownMs / 1000) });
            }
            throw error;
        }
    }
}

export function temporaryRpcFailure(error) {
    const e = classifyError(error);
    return ['transport', 'timeout', 'rate_limit', 'circuit'].includes(e.category)
        || ['rpc_missing_block', 'rpc_reference_unavailable', 'rpc_missing_reference_block', 'rpc_snapshot_behind'].includes(e.code);
}

const sameAnchor = (left, right) => !!left && !!right && left.number === right.number && left.hash === right.hash;

// Keep research runtimes frozen. Inherited reads retain their abort context,
// deadlines and failover validation; recovery work never delays a healthy read.
export class LayaRpcPool extends RpcPool {
    constructor(urls, coordinator, providers = urls.map(url => new LayaRpcProvider(url, coordinator.policy.circuitMs))) {
        const scoped = Object.create(coordinator);
        scoped.run = (key, endpoint, stage, task, options) => coordinator.run(key, endpoint, stage,
            (signal, attempt) => liveReadContext.run(signal, async () => {
                try { return await task(signal, attempt); }
                catch (error) {
                    const rejection = classifyError(error);
                    if (READ_ONLY_RPC_METHODS.has(rejection.rpcMethod))
                        coordinator.event('rpc_rejection', { error: safeError(rejection, { stage, endpoint }) });
                    throw error;
                }
            }), options);
        super(urls, scoped, providers);
        this.closed = false; this.foregroundReads = 0; this.readGeneration = 0; this.recoveryAt = 0;
    }
    async validate(provider, anchor, signal) {
        signal?.throwIfAborted();
        if (Number(await provider.send('eth_chainId', [])) !== 137) throw new OperationalError('rpc_wrong_chain');
        signal?.throwIfAborted();
        if (anchor) {
            const block = await provider.getBlock(anchor.number);
            signal?.throwIfAborted();
            if (!block?.hash) throw new OperationalError('rpc_missing_reference_block', 'transport');
            if (block.number !== anchor.number) throw new OperationalError('rpc_block_number_mismatch');
            if (block.hash !== anchor.hash) throw new OperationalError('rpc_block_mismatch');
        }
    }
    promoteRecoveredPrimary() {
        const ready = this.recoveredPrimary;
        if (!ready || this.closed || this.foregroundReads) return;
        this.recoveredPrimary = null;
        if (this.active !== ready.active || this.readGeneration !== ready.generation || !sameAnchor(this.anchor, ready.anchor)) return;
        this.active = 0; this.recoveryAt = 0;
        this.coordinator.event('rpc_failover', { endpoint: 'rpc_primary', stage: 'rpc_primary_recovery', block: ready.anchor.number });
    }
    probePrimary() {
        if (this.closed || !this.anchor || this.active === 0 || this.primaryRecoveryPending || this.coordinator.now() < this.recoveryAt) return;
        const anchor = { ...this.anchor }, active = this.active, generation = this.readGeneration;
        const controller = new AbortController(); this.primaryRecoveryController = controller;
        this.recoveryAt = this.coordinator.now() + this.coordinator.policy.circuitMs;
        // Invoke the inherited read path on an isolated, one-provider context:
        // it owns no live selection/anchor and preserves the private RPC abort
        // context. A separate key cannot coalesce with a financial read.
        let probeSignal;
        const coordinator = Object.create(this.coordinator);
        coordinator.run = (key, endpoint, stage, task, options) => this.coordinator.run(key, endpoint, stage,
            signal => {
                probeSignal = AbortSignal.any([signal, controller.signal]);
                return liveReadContext.run(probeSignal, () => task(probeSignal));
            }, options);
        const scoped = { providers: [this.providers[0]], coordinator, active: 0, anchor,
            validate: this.validate.bind(this), primaryProbeAt: Infinity };
        const pending = RpcPool.prototype.use.call(scoped, 'rpc_primary_recovery', async provider => {
            await this.validate(provider, anchor, probeSignal);
        }, { anchor, key: 'live_primary_recovery' }).then(() => {
            if (!this.closed && !controller.signal.aborted && this.active === active
                && this.readGeneration === generation && sameAnchor(this.anchor, anchor))
                this.recoveredPrimary = { anchor, active, generation };
        }).catch(() => {
            // The coordinator records probe failures. Healthy foreground reads
            // continue on the selected endpoint, including identity failures.
        }).finally(() => {
            if (this.primaryRecoveryPending === pending) {
                this.primaryRecoveryPending = null; this.primaryRecoveryController = null;
            }
        });
        this.primaryRecoveryPending = pending;
    }
    async use(stage, task, options) {
        if (this.closed) throw new OperationalError('rpc_closed');
        this.promoteRecoveredPrimary();
        const active = this.active;
        this.readGeneration++; this.foregroundReads++;
        // The inherited fallback order still reaches primary if backup fails.
        // Only the periodic primary preference moves off the request path.
        this.primaryProbeAt = Infinity;
        this.probePrimary();
        try { return await super.use(stage, task, options); }
        finally {
            this.foregroundReads--; this.primaryProbeAt = Infinity;
            if (this.active === 0) { this.recoveryAt = 0; this.recoveredPrimary = null; }
            else if (this.active !== active || !this.recoveryAt)
                this.recoveryAt = this.coordinator.now() + this.coordinator.policy.circuitMs;
        }
    }
    async snapshot() {
        if (this.closed) throw new OperationalError('rpc_closed');
        const now = this.coordinator.now();
        if (this.anchor && this.snapshotAt !== undefined && now >= this.snapshotAt && now - this.snapshotAt < 1000)
            return this.anchor.number;
        if (!this.snapshotPending) this.snapshotPending = this.refreshSnapshot().finally(() => { this.snapshotPending = null; });
        return this.snapshotPending;
    }
    async refreshSnapshot() {
        const anchor = await this.use('rpc_snapshot', async provider => {
            const head = await provider.getBlockNumber();
            if (!Number.isSafeInteger(head) || head < 1) throw new OperationalError('rpc_invalid_block_number');
            const number = head - 1, block = await provider.getBlock(number);
            if (!block?.hash) throw new OperationalError('rpc_missing_block', 'transport');
            if (block.number !== number) throw new OperationalError('rpc_block_number_mismatch');
            if (this.anchor && number < this.anchor.number) throw new OperationalError('rpc_snapshot_behind', 'transport');
            if (this.anchor?.number === number && this.anchor.hash !== block.hash) throw new OperationalError('rpc_block_mismatch');
            return { number, hash: block.hash };
        });
        if (this.closed) throw new OperationalError('rpc_closed');
        if (this.anchor && anchor.number < this.anchor.number) throw new OperationalError('rpc_snapshot_behind', 'transport');
        if (this.anchor?.number === anchor.number && this.anchor.hash !== anchor.hash) throw new OperationalError('rpc_block_mismatch');
        this.anchor = anchor; this.snapshotAt = this.coordinator.now();
        this.promoteRecoveredPrimary();
        return anchor.number;
    }
    close() {
        this.closed = true; this.recoveredPrimary = null;
        this.primaryRecoveryController?.abort();
        super.close();
    }
}
