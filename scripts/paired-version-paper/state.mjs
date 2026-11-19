import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { verifyValueObservation } from '../../src/value-collector/features.js';

const NAMES = ['old', 'new'], SLOTS = [90, 60, 30];
const DURATION = 300000, DAY = 86400000, SCALE = 1e6;
const INITIAL = 20 * SCALE, STOP = 10 * SCALE;
const token = v => typeof v === 'string' && /^[1-9]\d{0,77}$/.test(v);
const tokensOk = v => Array.isArray(v) && v.length === 2 && v.every(token) && v[0] !== v[1];
const conditionOk = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const guard = (condition, reason) => { if (!condition) throw new Error('paired_paper_' + reason); };
const units = (v, name) => {
    guard(Number.isFinite(v) && v >= 0 && Number.isSafeInteger(Math.round(v * SCALE)), name);
    return Math.round(v * SCALE);
};
const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    guard(value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value), 'invalid_json');
    return value;
};
const encode = value => JSON.stringify(canonical(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = JSON.parse;
const fresh = () => ({ cash: INITIAL, peak: INITIAL, drawdown: 0, stoppedAt: null,
    releasedAt: 0, position: null, attempts: 0, fills: 0, completed: 0, wins: 0, losses: 0,
    flats: 0, pnl: 0, fees: 0, gas: 0, principal: 0 });
const slotAfter = cursor => {
    const open = Math.floor(cursor / DURATION) * DURATION;
    for (const start of [open, open + DURATION]) {
        const marketEnd = start + DURATION, slug = 'btc-updown-5m-' + (start / 1000);
        for (const seconds of SLOTS) {
            const scheduledAt = marketEnd - seconds * 1000;
            if (scheduledAt > cursor) return { slug, marketEnd, scheduledAt, seconds };
        }
    }
};
const sameSlot = (a, b) => a.slug === b.slug && a.scheduledAt === b.scheduledAt && a.marketEnd === b.marketEnd;

// SQLite commits slot, virtual balances and cursor together. No trading clients, writes to
// other datasets, or recovery from guessed historical fills are needed after a crash.
export class PairedPaperStore {
    constructor({ directory, protocol, startAt, clock = Date.now }) {
        guard(path.isAbsolute(directory) && record(protocol) && Object.keys(protocol).length > 0 &&
            integer(startAt) && startAt > 0 && typeof clock === 'function', 'config');
        this.clock = clock;
        this.directory = directory;
        this.startAt = startAt;
        const manifest = encode({ schema: 1, protocol, startAt, slots: SLOTS, initialMicro: INITIAL,
            settledDrawdownMicro: STOP, commonStop: 'first_arm_realized_drawdown',
            accounting: 'paper_micro_pusd_no_external_cash', sizing: 'independent_virtual_cash' });
        this.protocolHash = hash(manifest);
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const filename = path.join(directory, 'paired-paper.sqlite');
        const fd = fs.openSync(filename, 'a', 0o600);
        fs.closeSync(fd);
        this.db = new DatabaseSync(filename);
        try {
            this.db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=131072; PRAGMA busy_timeout=2000;');
            this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(k TEXT PRIMARY KEY, v TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS slots(at INTEGER PRIMARY KEY, slug TEXT NOT NULL, status TEXT NOT NULL,
                    hash TEXT NOT NULL, input TEXT NOT NULL, disposition TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS attempts(name TEXT NOT NULL, slug TEXT NOT NULL, at INTEGER NOT NULL,
                    PRIMARY KEY(name, slug));
                CREATE TABLE IF NOT EXISTS labels(slug TEXT PRIMARY KEY, hash TEXT NOT NULL, proof TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS settlements(name TEXT NOT NULL, slug TEXT NOT NULL, entryAt INTEGER NOT NULL,
                    receivedAt INTEGER NOT NULL, pnl INTEGER NOT NULL, PRIMARY KEY(name, slug));`);
            this.transaction(() => {
                const existing = this.meta('manifest');
                if (existing) guard(existing === manifest, 'protocol_mismatch');
                else {
                    guard(!this.meta('state') && !this.db.prepare('SELECT 1 FROM slots LIMIT 1').get(), 'missing_manifest');
                    this.setMeta('manifest', manifest);
                    this.save({ lastScheduledAt: null, firstStopAt: null, arms: { old: fresh(), new: fresh() },
                        paired: { count: 0, readyDeltaSum: 0, askPairs: 0, askDeltaSum: 0,
                            sameReady: 0, newEarlier: 0, oldEarlier: 0 }, disposition: { old: {}, new: {} } });
                }
            });
        } catch (error) { this.db.close(); throw error; }
    }
    close() { this.db.close(); }
    meta(k) { return this.db.prepare('SELECT v FROM metadata WHERE k=?').get(k)?.v; }
    setMeta(k, v) {
        this.db.prepare('INSERT INTO metadata VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
    }
    get state() { return parse(this.meta('state')); }
    save(state) { this.setMeta('state', JSON.stringify(state)); }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try { const result = fn(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    nextSlot() { return slotAfter(this.state.lastScheduledAt ?? this.startAt - 1); }
    room() {
        const st = fs.statfsSync(this.directory);
        guard(st.bavail * st.bsize >= 2 * 1024 ** 3, 'storage_guard');
    }
    recordSlot(row) {
        guard(record(row) && integer(row.scheduledAt) && row.scheduledAt >= this.startAt &&
            row.scheduledAt <= this.clock(), 'prospective_slot');
        const bytes = encode(row), digest = hash(bytes);
        guard(Buffer.byteLength(bytes) <= 131072, 'slot_too_large');
        return this.transaction(() => {
            const existing = this.db.prepare('SELECT hash,disposition FROM slots WHERE at=?').get(row.scheduledAt);
            if (existing) {
                guard(existing.hash === digest, 'slot_conflict');
                return { created: false, disposition: parse(existing.disposition) };
            }
            this.room();
            const s = this.state, next = slotAfter(s.lastScheduledAt ?? this.startAt - 1);
            guard(sameSlot(row, next) && (row.seconds === undefined || row.seconds === next.seconds), 'slot_sequence');
            guard(['missing', 'unscorable', 'observed'].includes(row.status), 'slot_status');
            const disposition = {};
            let status = row.status;
            if (status === 'observed') {
                guard(record(row.arms) && NAMES.every(k => record(row.arms[k]) &&
                    ['skip', 'unscorable', 'no_fill', 'fill'].includes(row.arms[k].status)), 'arms_invalid');
                if (NAMES.some(k => row.arms[k].status === 'unscorable')) status = 'unscorable';
            }
            for (const name of NAMES) {
                const a = s.arms[name];
                if (status !== 'observed') { disposition[name] = status; continue; }
                const r = row.arms[name];
                if (s.firstStopAt !== null) { disposition[name] = 'common_research_stop'; continue; }
                if (r.status === 'skip') { disposition[name] = 'skip'; continue; }
                guard(conditionOk(row.conditionId) && tokensOk(row.tokens) &&
                    ['UP', 'DOWN'].includes(r.side) && r.tokenId === row.tokens[r.side === 'UP' ? 0 : 1], 'order_identity');
                const readyAt = r.readyAt, quoteAt = r.quoteAt ?? readyAt;
                guard(Number.isFinite(readyAt) && readyAt >= row.scheduledAt &&
                    Number.isFinite(quoteAt) && quoteAt >= readyAt && quoteAt < row.marketEnd && quoteAt <= this.clock(),
                'quote_time');
                const cost = r.status === 'fill' ? units(r.principal, 'principal') + units(r.fee, 'fee') + units(r.gas, 'gas') : 0;
                const reserve = units(r.reserveCost ?? cost / SCALE, 'reserve');
                guard(reserve <= 5 * SCALE && cost <= 5 * SCALE, 'order_budget');
                if (r.status === 'fill') guard(units(r.shares, 'shares') > 0 && units(r.principal, 'principal') > 0 &&
                    units(r.principal, 'principal') <= units(r.shares, 'shares'), 'invalid_fill');
                if (this.db.prepare('SELECT 1 FROM attempts WHERE name=? AND slug=?').get(name, row.slug)) {
                    disposition[name] = 'market_already_attempted'; continue;
                }
                // When a late snapshot is processed, settlement receipts seen after its
                // modeled ready time cannot retroactively release cash for a new trade.
                if (a.position || readyAt < a.releasedAt) { disposition[name] = 'position_busy'; continue; }
                if (Math.max(reserve, cost) > a.cash) { disposition[name] = 'virtual_cash_insufficient'; continue; }
                this.db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(name, row.slug, row.scheduledAt);
                a.attempts++;
                disposition[name] = r.status;
                if (r.status === 'fill') {
                    a.fills++;
                    a.cash -= cost; a.gas += units(r.gas, 'gas'); a.fees += units(r.fee, 'fee');
                    a.principal += units(r.principal, 'principal');
                    a.position = { slug: row.slug, marketEnd: row.marketEnd, tokens: row.tokens,
                        conditionId: row.conditionId.toLowerCase(), side: r.side, tokenId: r.tokenId,
                        shares: units(r.shares, 'shares'), cost, entryAt: quoteAt };
                }
            }
            for (const name of NAMES) {
                const counts = s.disposition[name], key = disposition[name]; counts[key] = (counts[key] || 0) + 1;
            }
            // Compare only paired quotes for actual modeled attempts, on a shared side.
            // Excluding cash/position skips avoids conflating timing with different bankrolls.
            if (NAMES.every(k => ['fill', 'no_fill'].includes(disposition[k])) &&
                row.arms.old.side === row.arms.new.side) {
                const { old, new: modern } = row.arms, delta = modern.readyAt - old.readyAt;
                const p = s.paired;
                p.count++; p.readyDeltaSum += delta; p[delta < 0 ? 'newEarlier' : delta > 0 ? 'oldEarlier' : 'sameReady']++;
                if ([modern.bestAsk, old.bestAsk].every(v => Number.isFinite(v) && v > 0 && v < 1)) {
                    p.askPairs++; p.askDeltaSum += modern.bestAsk - old.bestAsk;
                }
            }
            this.db.prepare('INSERT INTO slots VALUES (?,?,?,?,?,?)').run(row.scheduledAt, row.slug, status,
                digest, bytes, JSON.stringify(disposition));
            s.lastScheduledAt = row.scheduledAt; this.save(s);
            return { created: true, disposition };
        });
    }
    pendingMarkets() {
        const result = new Map();
        for (const a of Object.values(this.state.arms)) if (a.position) {
            const { slug, marketEnd, conditionId, tokens } = a.position;
            result.set(slug, { slug, marketEnd, conditionId, tokens });
        }
        return [...result.values()];
    }
    settle(label, observation, receivedAt = this.clock()) {
        guard(record(label) && label.official === true && label.source === 'ctf_payout' &&
            conditionOk(label.conditionId) && typeof label.slug === 'string', 'label');
        const officialAt = label.at ?? label.observedAt, pay = label.payout;
        guard(integer(label.marketEnd) && integer(officialAt) && integer(receivedAt) && officialAt >= label.marketEnd &&
            receivedAt >= officialAt && receivedAt <= this.clock() && Array.isArray(pay) && pay.length === 2 &&
            pay.every(v => Number.isFinite(v) && v >= 0 && v <= 1) && Math.abs(pay[0] + pay[1] - 1) <= 1e-9 &&
            label.outcome === (pay[0] === 1 && pay[1] === 0 ? 'UP' : pay[0] === 0 && pay[1] === 1 ? 'DOWN' : 'SPLIT'),
        'label_payout');
        const features = observation?.features, market = features?.market;
        guard(verifyValueObservation(features) && conditionOk(observation.conditionId) && conditionOk(market?.conditionId) &&
            observation.slug === label.slug && market.slug === label.slug && observation.marketEnd === label.marketEnd &&
            market.end === label.marketEnd && market.open === label.marketEnd - DURATION && tokensOk(market.tokens) &&
            observation.conditionId.toLowerCase() === label.conditionId.toLowerCase() &&
            market.conditionId.toLowerCase() === label.conditionId.toLowerCase() &&
            features.sides?.length === 2 && ['UP', 'DOWN'].every((side, i) =>
                features.sides[i].side === side && features.sides[i].tokenId === market.tokens[i]), 'label_token_identity');
        const identity = { slug: label.slug, marketEnd: label.marketEnd, conditionId: label.conditionId.toLowerCase(),
            tokens: market.tokens, payout: pay, outcome: label.outcome, officialAt };
        const digest = hash(encode(identity));
        return this.transaction(() => {
            const prior = this.db.prepare('SELECT hash FROM labels WHERE slug=?').get(label.slug);
            if (prior) { guard(prior.hash === digest, 'label_conflict'); return { settled: [] }; }
            const s = this.state, settled = [];
            for (const name of NAMES) {
                const a = s.arms[name], p = a.position;
                if (!p || p.slug !== label.slug) continue;
                guard(p.marketEnd === label.marketEnd && p.conditionId === identity.conditionId &&
                    p.tokens.every((v, i) => v === market.tokens[i]) && label.marketEnd > p.entryAt, 'settlement_identity');
                const gross = Math.round(p.shares * pay[p.side === 'UP' ? 0 : 1]), pnl = gross - p.cost;
                a.cash += gross; a.pnl += pnl; a.completed++; a[pnl > 0 ? 'wins' : pnl < 0 ? 'losses' : 'flats']++;
                a.peak = Math.max(a.peak, a.cash); a.drawdown = Math.max(a.drawdown, a.peak - a.cash);
                a.releasedAt = receivedAt; a.position = null;
                if (a.drawdown >= STOP && a.stoppedAt === null) {
                    a.stoppedAt = receivedAt; s.firstStopAt ??= receivedAt;
                }
                this.db.prepare('INSERT INTO settlements VALUES(?,?,?,?,?)').run(name, label.slug, p.entryAt, receivedAt, pnl);
                settled.push(name);
            }
            if (settled.length) {
                this.room();
                this.db.prepare('INSERT INTO labels VALUES (?,?,?)').run(label.slug, digest,
                    JSON.stringify({ ...identity, observedFeatureHash: features.featureHash, receivedAt }));
                this.save(s);
            }
            return { settled };
        });
    }
    report(now = this.clock()) {
        const s = this.state, last = s.lastScheduledAt, cutoff = Math.min(s.firstStopAt ?? Infinity, now, last ?? this.startAt);
        const durationDays = Math.max(0, cutoff - this.startAt) / DAY;
        const counts = Object.fromEntries(this.db.prepare('SELECT status, COUNT(*) AS n FROM slots GROUP BY status')
            .all().map(r => [r.status, r.n]));
        const arms = Object.fromEntries(NAMES.map(name => {
            const a = s.arms[name];
            const days = this.db.prepare('SELECT count(distinct cast(entryAt / 86400000 as integer)) AS n FROM settlements WHERE name=?')
                .get(name).n;
            return [name, { attempts: a.attempts, fills: a.fills, completed: a.completed, wins: a.wins, losses: a.losses,
                flats: a.flats, netPnl: a.pnl / SCALE, cash: a.cash / SCALE, gas: a.gas / SCALE,
                entryFees: a.fees / SCALE, principal: a.principal / SCALE, maxRealizedDrawdown: a.drawdown / SCALE,
                open: Boolean(a.position), stoppedAt: a.stoppedAt, entryDaysUTC: days }];
        }));
        const p = s.paired;
        return { protocolHash: this.protocolHash, startAt: this.startAt, asOf: now, lastScheduledAt: last,
            firstStopAt: s.firstStopAt, observedCommonDays: durationDays, slots: counts, arms,
            dispositions: s.disposition, pairedExecution: { pairedAttempts: p.count, sameReady: p.sameReady,
                newEarlier: p.newEarlier, oldEarlier: p.oldEarlier, meanReadyDeltaNewMinusOldMs: p.count ? p.readyDeltaSum / p.count : null,
                pairedAsks: p.askPairs, meanBestAskDeltaNewMinusOld: p.askPairs ? p.askDeltaSum / p.askPairs : null },
            minimumSampleReached: durationDays >= 7 && NAMES.every(k => arms[k].completed >= 100 && arms[k].entryDaysUTC >= 7),
            automaticPromotion: false };
    }
}
