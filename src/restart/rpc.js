import { AsyncLocalStorage } from 'node:async_hooks';
import { ethers } from 'ethers';
import { OperationalError, fetchResponse, retryable } from './network.js';

const readContext = new AsyncLocalStorage();

export class RpcProvider extends ethers.providers.JsonRpcProvider {
    constructor(url) { super({ url, timeout: 3000 }, { name: 'polygon', chainId: 137 }); this.requestId = 0; }
    async send(method, params) {
        const response = await fetchResponse(this.connection.url, { method: 'POST',
            signal: readContext.getStore(), headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }) });
        const raw = await response.json();
        if (raw.error) throw new OperationalError(raw.error.code === -32005 ? 'rate_limited' : 'rpc_rejected',
            raw.error.code === -32005 ? 'rate_limit' : 'contract');
        if (!Object.hasOwn(raw, 'result')) throw new OperationalError('invalid_rpc_response');
        return raw.result;
    }
}

export class RpcPool {
    constructor(urls, coordinator, providers = urls.map(url => new RpcProvider(url))) {
        this.providers = providers; this.coordinator = coordinator; this.active = 0; this.anchor = null; this.primaryProbeAt = 0;
    }
    async validate(provider, anchor) {
        if (Number(await provider.send('eth_chainId', [])) !== 137) throw new OperationalError('rpc_wrong_chain');
        if (anchor) {
            const block = await provider.getBlock(anchor.number);
            if (!block || block.hash !== anchor.hash) throw new OperationalError('rpc_block_mismatch');
        }
    }
    async use(stage, task, { anchor = this.anchor, key = stage } = {}) {
        const first = this.active !== 0 && this.coordinator.now() >= this.primaryProbeAt ? 0 : this.active;
        const candidates = [first, ...this.providers.map((_, i) => i).filter(i => i !== first)];
        let last;
        for (const index of candidates) {
            const label = index === 0 ? 'rpc_primary' : 'rpc_backup';
            try {
                if (index !== first && !anchor) throw new OperationalError('rpc_reference_unavailable');
                const result = await this.coordinator.run(`rpc:${key}:${index}`, label, stage, signal =>
                    readContext.run(signal, async () => {
                        if (index !== this.active || !this.anchor) await this.validate(this.providers[index], anchor);
                        return task(this.providers[index]);
                    }), { retries: 0 });
                if (index !== this.active) this.coordinator.event('rpc_failover', { endpoint: label, stage, block: anchor?.number ?? null });
                if (index !== 0 && (index !== this.active || first === 0))
                    this.primaryProbeAt = this.coordinator.now() + this.coordinator.policy.circuitMs;
                this.active = index;
                return result;
            } catch (error) {
                last = error;
                if (!retryable(error) && error.code !== 'circuit_open') throw error;
                if (error.code !== 'circuit_open' && error.code !== 'rate_limit_wait')
                    await this.coordinator.sleep(this.coordinator.policy.retryMinMs + this.coordinator.random()
                        * (this.coordinator.policy.retryMaxMs - this.coordinator.policy.retryMinMs));
            }
        }
        throw last;
    }
    async snapshot() {
        const anchor = await this.use('rpc_snapshot', async provider => {
            const number = Math.max(0, await provider.getBlockNumber() - 1);
            const block = await provider.getBlock(number);
            if (!block?.hash) throw new OperationalError('rpc_missing_block');
            return { number, hash: block.hash };
        });
        this.anchor = anchor; return anchor.number;
    }
    async read(stage, task, blockTag, key = stage) {
        if (!this.anchor) await this.snapshot();
        if (blockTag !== undefined && blockTag !== this.anchor.number)
            throw new OperationalError('rpc_snapshot_changed');
        const anchor = { ...this.anchor };
        return this.use(stage, provider => task(provider, anchor.number), { anchor, key: `${key}:${anchor.number}` });
    }
    close() { for (const provider of this.providers) { provider.removeAllListeners(); provider.polling = false; } }
}
