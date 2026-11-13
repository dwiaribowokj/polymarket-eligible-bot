import crypto from 'node:crypto';
import { ShadowEngine, candidateChecks, metadataIdentity, verifyStreamSnapshot } from '../ai-shadow/engine.js';
import { encodeFeatures } from '../ai-shadow/history.js';
import { round } from '../restart/math.js';

export class LayaPaperEngine extends ShadowEngine {
    async tick(now = this.clock()) {
        const arm = this.store.state.arms.laya;
        if (arm.completed.length >= this.config.maxMarkets && !arm.stopped) {
            arm.stopped = { at: now, reason: 'market_limit' };
            this.store.event('arm_stopped', { reason: 'market_limit' });
        }
        if (arm.stopped && !this.store.state.frozenAt) {
            this.store.state.frozenAt = arm.stopped.at;
            this.store.event('entries_frozen', { reason: arm.stopped.reason });
        }
        await super.tick(now);
    }
    async observe(market, seconds, key) {
        const arm = this.store.state.arms.laya;
        if (arm.stopped || arm.position || arm.seen[market.slug]) {
            this.store.state.slots[key].status = 'arm_unavailable'; this.store.save(); return;
        }
        const started = this.clock(), generation = this.books.generation;
        const rest = await this.client.books(market);
        let now = this.clock();
        const slotEnd = market.end - seconds * 1000 + this.config.slotToleranceMs;
        if (this.closed || now >= this.config.deadline || now > slotEnd) throw new Error('slot_late_after_validation');
        const validation = { at: now, generation, identity: metadataIdentity(market) };
        await verifyStreamSnapshot(this.client, this.books, market, validation, this.clock, this.config.dataAgeMs);
        const { initial, features, timing, bookSource } = await this.freshSnapshot(market, seconds, rest, validation);
        now = this.clock();
        if (this.closed || now >= this.config.deadline || now > slotEnd) throw new Error('slot_late_after_validation');
        timing.validationMs = validation.at - started;
        const checks = candidateChecks(market, initial, this.config, arm.cash, now);
        const allowed = checks.flatMap(check => check.order ? [check.order] : []);
        if (!allowed.length) {
            this.store.state.slots[key].status = 'no_valid_side';
            this.store.event('opportunity_skipped', { slug: market.slug, slot: seconds, reasons: checks.map(c => c.reason) }); return;
        }
        for (const order of allowed) {
            const assessed = this.client.btc.assess(market, order, this.config.control, now);
            if (assessed.reason && !['btc_edge_insufficient', 'btc_direction_disagrees'].includes(assessed.reason)) throw new Error(assessed.reason);
        }
        features.state.allowed = allowed.map(o => o.index === 0 ? 'BUY_UP' : 'BUY_DOWN');
        features.state.limit_cost_up_down = [0, 1].map(index => {
            const order = allowed.find(o => o.index === index); return order ? [round(order.price * 100), order.cost] : null;
        });
        const input = encodeFeatures(features.state);
        const snapshotId = crypto.createHash('sha256').update(JSON.stringify({ market: market.slug, seconds, now, input })).digest('hex').slice(0, 24);
        const snapshot = { snapshotId, market: market.slug, slot: seconds, at: now, observedAt: features.observedAt,
            state: features.state, input, inputHash: crypto.createHash('sha256').update(input).digest('hex'),
            bookSource, validation, timing, decisions: {} };
        this.store.state.snapshots.push(snapshot); this.store.state.slots[key].status = 'observed';
        this.store.event('snapshot', { snapshotId, slug: market.slug, slot: seconds, inputHash: snapshot.inputHash, timing });
        const decision = await this.providers.predict('laya', snapshot);
        snapshot.decisions.laya = decision; this.store.event('decision', { provider: 'laya', ...decision });
        this.apply('laya', decision, snapshot, market, allowed);
        this.store.save();
    }
}
