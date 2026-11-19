import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PairedPaperStore } from '../../scripts/paired-version-paper/state.mjs';

const firstOpen = 1800000000000, startAt = firstOpen + 209000, clock = () => firstOpen + 20 * 86400000;
const id = '0x' + 'ab'.repeat(32), tokens = ['101', '203'];
const open = (directory, extra = {}) => new PairedPaperStore({ directory, startAt, clock, protocol: { model: 'fixed' }, ...extra });
function temp(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paired-ledger-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
const input = (store, old = 'fill', modern = 'fill') => {
    const next = store.nextSlot();
    const arm = (status, lag) => ({ status, side: 'UP', tokenId: tokens[0], readyAt: next.scheduledAt + lag,
        quoteAt: next.scheduledAt + lag + 80, shares: 5, principal: 3.8, fee: 0.06, gas: 0.05, reserveCost: 4 });
    return { ...next, conditionId: id, tokens, status: 'observed', arms: { old: arm(old, 50), new: arm(modern, 680) } };
};
function proof(slot, payout, tokenIds = tokens) {
    const { slug, marketEnd, scheduledAt } = slot, at = scheduledAt + 1000;
    const market = { slug, open: marketEnd - 300000, end: marketEnd, conditionId: id, tokens: tokenIds };
    const payload = { schema: 'btc5m-value-observation-v1', at, scheduledAt, market,
        sides: tokenIds.map((tokenId, i) => ({ side: i === 0 ? 'UP' : 'DOWN', tokenId })) };
    function canon(x) {
        return Array.isArray(x) ? x.map(canon) : x && typeof x === 'object'
            ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canon(x[k])])) : x;
    }
    const featureHash = createHash('sha256').update(JSON.stringify(canon(payload))).digest('hex');
    const observation = { slug, marketEnd, conditionId: id, features: { ...payload, featureHash, snapshotId: featureHash } };
    return [{ slug, marketEnd, at: marketEnd + 10000, conditionId: id, official: true,
        source: 'ctf_payout', outcome: payout[0] === 1 ? 'UP' : payout[1] === 1 ? 'DOWN' : 'SPLIT', payout }, observation];
}
const miss = store => store.recordSlot({ ...store.nextSlot(), status: 'missing', reason: 'no_input' });
test('atomic joint slot survives reopen; mismatched protocol, reassigned data or a silent slot gap cannot replay history', t => {
    const dir = temp(t); let store = open(dir);
    const slot = input(store, 'fill', 'no_fill');
    slot.arms.old.bestAsk = 0.75; slot.arms.new.bestAsk = 0.77;
    assert.deepEqual(store.recordSlot(slot).disposition, { old: 'fill', new: 'no_fill' });
    store.close(); assert.throws(() => open(dir, { startAt: startAt + 1 }), /protocol_mismatch/);
    store = open(dir); t.after(() => store.close());
    assert.equal(store.recordSlot(slot).created, false);
    assert.throws(() => store.recordSlot({ ...slot, evidence: { fake: true } }), /slot_conflict/);
    assert.throws(() => store.recordSlot({ ...slot, scheduledAt: slot.scheduledAt + 60000 }), /slot_sequence/);
    assert.deepEqual(store.recordSlot(input(store)).disposition, { old: 'market_already_attempted', new: 'market_already_attempted' });
    const r = store.report();
    assert.equal(r.arms.old.cash, 16.09); assert.equal(r.arms.new.cash, 20); assert.equal(r.arms.old.netPnl, 0);
    assert.equal(r.arms.old.completed, 0); assert.equal(store.pendingMarkets().length, 1);
    assert.equal(r.pairedExecution.pairedAttempts, 1); assert.equal(r.pairedExecution.meanReadyDeltaNewMinusOldMs, 630);
    assert.equal(r.pairedExecution.pairedAsks, 1);
    assert.ok(Math.abs(r.pairedExecution.meanBestAskDeltaNewMinusOld - 0.02) < 1e-10);
    assert.equal(r.dispositions.new.no_fill, 1);
});
test('both arms excluded on missing quote; valid skip leaves next slot available and corrupted entry cannot partially debit arm', t => {
    const store = open(temp(t)); t.after(() => store.close());
    const a = input(store, 'fill', 'unscorable'); store.recordSlot(a);
    assert.equal(store.report().arms.old.cash, 20); assert.deepEqual(store.report().slots, { unscorable: 1 });
    const b = input(store, 'fill', 'fill'), corrupt = structuredClone(b);
    corrupt.arms.new.tokenId = tokens[1];
    assert.throws(() => store.recordSlot(corrupt), /order_identity/);
    assert.equal(store.report().arms.old.cash, 20); assert.equal(store.nextSlot().scheduledAt, b.scheduledAt);
    b.arms.old.status = 'skip'; store.recordSlot(b);
    assert.deepEqual(store.recordSlot(input(store)).disposition, { old: 'fill', new: 'market_already_attempted' });
});
test('only matching official label and verified token order settle actions; a duplicate cannot earn twice', t => {
    const store = open(temp(t)); t.after(() => store.close());
    const slot = input(store); store.recordSlot(slot);
    const [label, observed] = proof(slot, [1, 0]);
    assert.throws(() => store.settle({ ...label, official: false }, observed), /paired_paper_label/);
    const wrong = structuredClone(observed); wrong.features.market.tokens.reverse();
    assert.throws(() => store.settle(label, wrong), /label_token_identity/);
    assert.throws(() => store.settle(...proof(slot, [1, 0], [...tokens].reverse())), /settlement_identity/);
    assert.throws(() => store.settle(label, observed, label.at - 1), /label_payout/);
    assert.deepEqual(store.settle(label, observed, label.at + 1).settled, ['old', 'new']);
    assert.deepEqual(store.settle(label, observed, label.at + 2).settled, []);
    assert.throws(() => store.settle(...proof(slot, [0, 1])), /label_conflict/);
    for (const a of Object.values(store.report().arms)) {
        assert.equal(a.netPnl, 1.09); assert.equal(a.cash, 21.09); assert.equal(a.wins, 1);
        assert.equal(a.entryFees, 0.06); assert.equal(a.gas, 0.05); assert.equal(a.maxRealizedDrawdown, 0);
    }
});
test('pending inventory and delayed labels cannot free future funds for an earlier slot', t => {
    const store = open(temp(t)); t.after(() => store.close());
    const entry = input(store); store.recordSlot(entry); miss(store); miss(store);
    const next = input(store); assert.deepEqual(store.recordSlot(next).disposition, { old: 'position_busy', new: 'position_busy' });
    store.settle(...proof(entry, [0, 1]), next.scheduledAt + 45000);
    assert.deepEqual(store.recordSlot(input(store)).disposition, { old: 'position_busy', new: 'position_busy' });
    assert.deepEqual(store.recordSlot(input(store)).disposition, { old: 'fill', new: 'fill' });
});
test('research stop freezes paired admission after three losses; never counts missing coverage as profitable evidence', t => {
    const store = open(temp(t)); t.after(() => store.close());
    for (let i = 0; i < 3; i++) {
        const slot = input(store, 'fill', 'skip');
        store.recordSlot(slot); miss(store); miss(store);
        store.settle(...proof(slot, [0, 1]), slot.marketEnd + 11000);
    }
    const r = store.report();
    assert.equal(r.arms.old.netPnl, -11.73); assert.equal(r.arms.old.maxRealizedDrawdown, 11.73);
    assert.equal(r.arms.new.cash, 20); assert.ok(r.firstStopAt); assert.equal(r.minimumSampleReached, false);
    assert.equal(r.automaticPromotion, false);
    assert.deepEqual(store.recordSlot(input(store)).disposition, { old: 'common_research_stop', new: 'common_research_stop' });
});
