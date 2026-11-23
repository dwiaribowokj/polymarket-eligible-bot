import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { round } from '../../src/restart/math.js';
import {
    ARM_DEFS,
    ARM_NAMES,
    DRAWDOWN_STOP,
    GAS_USD,
    INITIAL_CASH,
    MIN_EVAL_COMPLETED,
    MIN_EVAL_DAYS,
    PROTOCOL_VERSION,
} from './strategies.mjs';

const U = 1_000_000;
const toMicro = v => Math.round(v * U);
const fromMicro = v => round(v / U);
const sha = v => createHash('sha256').update(v).digest('hex');

export class CandidatePaperStore {
    constructor({ directory, startAt = Date.now(), protocolMeta = {} }) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        this.directory = directory;
        this.dbPath = path.join(directory, 'candidates-paper.sqlite');
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS metadata (
                k TEXT PRIMARY KEY,
                v TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS slots (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                market_end INTEGER NOT NULL,
                seconds INTEGER NOT NULL,
                at INTEGER NOT NULL,
                context TEXT NOT NULL,
                decisions TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orders (
                id TEXT PRIMARY KEY,
                arm TEXT NOT NULL,
                slug TEXT NOT NULL,
                condition_id TEXT NOT NULL,
                market_end INTEGER NOT NULL,
                slot_seconds INTEGER NOT NULL,
                execution TEXT NOT NULL,
                side_index INTEGER NOT NULL,
                side TEXT NOT NULL,
                token_id TEXT NOT NULL,
                requested_shares REAL NOT NULL,
                limit_price REAL NOT NULL,
                queue_ahead REAL NOT NULL,
                created_at INTEGER NOT NULL,
                active_at INTEGER NOT NULL,
                status TEXT NOT NULL,
                cancel_reason TEXT,
                filled_shares REAL NOT NULL DEFAULT 0,
                notional_micro INTEGER NOT NULL DEFAULT 0,
                fee_micro INTEGER NOT NULL DEFAULT 0,
                gas_micro INTEGER NOT NULL DEFAULT 0,
                closed_at INTEGER,
                settled INTEGER NOT NULL DEFAULT 0,
                payout_micro INTEGER NOT NULL DEFAULT 0,
                pnl_micro INTEGER NOT NULL DEFAULT 0,
                settled_at INTEGER,
                UNIQUE(arm, slug)
            );
            CREATE TABLE IF NOT EXISTS labels (
                condition_id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                market_end INTEGER NOT NULL,
                payout TEXT NOT NULL,
                outcome TEXT NOT NULL,
                resolved_at INTEGER NOT NULL
            );
        `);

        const protocol = {
            version: PROTOCOL_VERSION,
            initialCash: INITIAL_CASH,
            drawdownStop: DRAWDOWN_STOP,
            gasUsd: GAS_USD,
            arms: ARM_DEFS,
            ...protocolMeta,
        };
        const protocolHash = sha(JSON.stringify(protocol));
        const existingStart = this._getMeta('startAt');
        if (!existingStart) {
            this._setMeta('startAt', String(startAt));
            this._setMeta('protocolHash', protocolHash);
            this._setMeta('protocol', JSON.stringify(protocol));
        }
        this.startAt = Number(this._getMeta('startAt'));
        this.protocolHash = this._getMeta('protocolHash');
        this.armState = this._rebuildArmState();
    }

    expireOrphanedOpenOrders(now = Date.now()) {
        const res = this.db.prepare(`
            UPDATE orders
            SET status = 'expired', cancel_reason = 'process_restarted', closed_at = ?
            WHERE status IN ('pending_taker', 'open_maker') AND filled_shares = 0
        `).run(now);
        if (res.changes > 0) this.armState = this._rebuildArmState();
        return res.changes;
    }

    _getMeta(k) {
        const row = this.db.prepare('SELECT v FROM metadata WHERE k = ?').get(k);
        return row ? row.v : null;
    }

    _setMeta(k, v) {
        this.db.prepare('INSERT OR REPLACE INTO metadata(k, v) VALUES (?, ?)').run(k, v);
    }

    _emptyArm() {
        const init = toMicro(INITIAL_CASH);
        return {
            cashMicro: init,
            peakMicro: init,
            maxDrawdownMicro: 0,
            stoppedAt: null,
            attempts: 0,
            postedMakers: 0,
            filled: 0,
            partialFills: 0,
            unfilledCanceled: 0,
            adverseCancels: 0,
            timeoutCancels: 0,
            completed: 0,
            wins: 0,
            losses: 0,
            flats: 0,
            netPnlMicro: 0,
            feeMicro: 0,
            gasMicro: 0,
            principalMicro: 0,
            entryDays: new Set(),
        };
    }

    _rebuildArmState() {
        const state = Object.fromEntries(ARM_NAMES.map(n => [n, this._emptyArm()]));
        const rows = this.db.prepare('SELECT * FROM orders ORDER BY created_at ASC, id ASC').all();
        for (const r of rows) {
            const a = state[r.arm];
            if (!a) continue;
            a.attempts++;
            if (r.execution === 'maker') a.postedMakers++;
            if (r.cancel_reason === 'binance_adverse_cancel') a.adverseCancels++;
            if (r.cancel_reason === 'timeout_cancel') a.timeoutCancels++;
            if (r.filled_shares > 0) {
                a.filled++;
                if (r.filled_shares < r.requested_shares - 1e-6) a.partialFills++;
                a.cashMicro -= (r.notional_micro + r.fee_micro + r.gas_micro);
                a.principalMicro += r.notional_micro;
                a.feeMicro += r.fee_micro;
                a.gasMicro += r.gas_micro;
                a.entryDays.add(new Date(r.created_at).toISOString().slice(0, 10));
            } else if (['canceled', 'no_fill', 'expired'].includes(r.status)) {
                a.unfilledCanceled++;
            }
            if (r.settled && r.filled_shares > 0) {
                a.cashMicro += r.payout_micro;
                a.netPnlMicro += r.pnl_micro;
                a.completed++;
                if (r.pnl_micro > 0) a.wins++;
                else if (r.pnl_micro < 0) a.losses++;
                else a.flats++;
                if (a.cashMicro > a.peakMicro) a.peakMicro = a.cashMicro;
                const dd = a.peakMicro - a.cashMicro;
                if (dd > a.maxDrawdownMicro) a.maxDrawdownMicro = dd;
                if (dd >= toMicro(DRAWDOWN_STOP) && a.stoppedAt === null) a.stoppedAt = r.settled_at;
            }
        }
        return state;
    }

    hasAttempt(arm, slug) {
        return Boolean(this.db.prepare('SELECT 1 FROM orders WHERE arm = ? AND slug = ?').get(arm, slug));
    }

    hasSlot(slug, seconds) {
        return Boolean(this.db.prepare('SELECT 1 FROM slots WHERE id = ?').get(`${slug}:${seconds}`));
    }

    armCanEnter(arm, slug, maxCostUsd) {
        const a = this.armState[arm];
        if (!a || a.stoppedAt !== null) return { ok: false, reason: 'arm_drawdown_stopped' };
        if (this.hasAttempt(arm, slug)) return { ok: false, reason: 'already_attempted_market' };
        if (a.cashMicro < toMicro(maxCostUsd)) return { ok: false, reason: 'insufficient_virtual_cash' };
        return { ok: true, reason: null };
    }

    recordSlot({ slug, marketEnd, seconds, at, context, decisions }) {
        this.db.prepare(`
            INSERT OR IGNORE INTO slots(id, slug, market_end, seconds, at, context, decisions)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(`${slug}:${seconds}`, slug, marketEnd, seconds, at, JSON.stringify(context), JSON.stringify(decisions));
    }

    createOrder(order) {
        const id = `${order.arm}:${order.slug}`;
        this.db.prepare(`
            INSERT INTO orders(
                id, arm, slug, condition_id, market_end, slot_seconds, execution,
                side_index, side, token_id, requested_shares, limit_price, queue_ahead,
                created_at, active_at, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, order.arm, order.slug, order.conditionId, order.marketEnd, order.slotSeconds,
            order.execution, order.index, order.side, order.tokenId, order.shares,
            order.price, order.queueAhead ?? 0, order.createdAt, order.activeAt, order.status,
        );
        const a = this.armState[order.arm];
        a.attempts++;
        if (order.execution === 'maker') a.postedMakers++;
        return id;
    }

    finalizeOrder(id, { status, cancelReason = null, filledShares = 0, notionalUsd = 0, feeUsd = 0, gasUsd = 0, closedAt }) {
        const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
        if (!row) throw new Error(`missing_order_${id}`);
        const notionalMicro = toMicro(notionalUsd);
        const feeMicro = toMicro(feeUsd);
        const gasMicro = filledShares > 0 ? toMicro(gasUsd) : 0;
        this.db.prepare(`
            UPDATE orders SET status = ?, cancel_reason = ?, filled_shares = ?,
                notional_micro = ?, fee_micro = ?, gas_micro = ?, closed_at = ?
            WHERE id = ?
        `).run(status, cancelReason, round(filledShares), notionalMicro, feeMicro, gasMicro, closedAt, id);

        const a = this.armState[row.arm];
        if (cancelReason === 'binance_adverse_cancel') a.adverseCancels++;
        if (cancelReason === 'timeout_cancel') a.timeoutCancels++;
        if (filledShares > 0) {
            a.filled++;
            if (filledShares < row.requested_shares - 1e-6) a.partialFills++;
            a.cashMicro -= (notionalMicro + feeMicro + gasMicro);
            a.principalMicro += notionalMicro;
            a.feeMicro += feeMicro;
            a.gasMicro += gasMicro;
            a.entryDays.add(new Date(row.created_at).toISOString().slice(0, 10));
        } else {
            a.unfilledCanceled++;
        }
    }

    unsettledMarkets() {
        return this.db.prepare(`
            SELECT DISTINCT condition_id AS conditionId, slug, market_end AS marketEnd
            FROM orders
            WHERE settled = 0 AND filled_shares > 0 AND status IN ('filled', 'partial', 'canceled')
            ORDER BY market_end ASC
        `).all();
    }

    settleMarket({ conditionId, slug, marketEnd, payout, outcome, resolvedAt }) {
        this.db.prepare(`
            INSERT OR IGNORE INTO labels(condition_id, slug, market_end, payout, outcome, resolved_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(conditionId, slug, marketEnd, JSON.stringify(payout), outcome, resolvedAt);

        const rows = this.db.prepare(`
            SELECT * FROM orders
            WHERE condition_id = ? AND settled = 0 AND filled_shares > 0 AND status IN ('filled', 'partial', 'canceled')
            ORDER BY created_at ASC
        `).all(conditionId);

        let settledCount = 0;
        for (const r of rows) {
            const winRatio = payout[r.side_index] ?? 0;
            const payoutMicro = toMicro(r.filled_shares * winRatio);
            const totalCostMicro = r.notional_micro + r.fee_micro + r.gas_micro;
            const pnlMicro = payoutMicro - totalCostMicro;
            this.db.prepare(`
                UPDATE orders SET settled = 1, payout_micro = ?, pnl_micro = ?, settled_at = ?
                WHERE id = ?
            `).run(payoutMicro, pnlMicro, resolvedAt, r.id);

            const a = this.armState[r.arm];
            a.cashMicro += payoutMicro;
            a.netPnlMicro += pnlMicro;
            a.completed++;
            if (pnlMicro > 0) a.wins++;
            else if (pnlMicro < 0) a.losses++;
            else a.flats++;
            if (a.cashMicro > a.peakMicro) a.peakMicro = a.cashMicro;
            const dd = a.peakMicro - a.cashMicro;
            if (dd > a.maxDrawdownMicro) a.maxDrawdownMicro = dd;
            if (dd >= toMicro(DRAWDOWN_STOP) && a.stoppedAt === null) a.stoppedAt = resolvedAt;
            settledCount++;
        }
        return settledCount;
    }

    report({ now = Date.now(), health = {} } = {}) {
        const slotCount = this.db.prepare('SELECT COUNT(*) AS n FROM slots').get().n;
        const labelCount = this.db.prepare('SELECT COUNT(*) AS n FROM labels').get().n;
        const openOrders = this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending_taker', 'open_maker')").get().n;
        const pendingSettlement = this.unsettledMarkets().length;
        const durationDays = round((now - this.startAt) / 86_400_000);

        const arms = {};
        for (const def of ARM_DEFS) {
            const a = this.armState[def.name];
            const wr = a.completed > 0 ? round((a.wins / a.completed) * 100) : null;
            const fillRate = a.attempts > 0 ? round((a.filled / a.attempts) * 100) : null;
            const netPnl = fromMicro(a.netPnlMicro);
            const gas = fromMicro(a.gasMicro);
            const fees = fromMicro(a.feeMicro);
            arms[def.name] = {
                description: def.description,
                execution: def.execution,
                attempts: a.attempts,
                filled: a.filled,
                fillRatePct: fillRate,
                partialFills: a.partialFills,
                unfilledCanceled: a.unfilledCanceled,
                adverseCancels: a.adverseCancels,
                timeoutCancels: a.timeoutCancels,
                completed: a.completed,
                wins: a.wins,
                losses: a.losses,
                flats: a.flats,
                winRatePct: wr,
                netPnl,
                netPnlExGas: round(netPnl + gas),
                cash: fromMicro(a.cashMicro),
                principal: fromMicro(a.principalMicro),
                fees,
                gas,
                maxDrawdown: fromMicro(a.maxDrawdownMicro),
                stoppedAt: a.stoppedAt,
                entryDaysUTC: a.entryDays.size,
                minimumSampleReached: durationDays >= MIN_EVAL_DAYS && a.completed >= MIN_EVAL_COMPLETED && a.entryDays.size >= MIN_EVAL_DAYS,
            };
        }

        return {
            protocolVersion: PROTOCOL_VERSION,
            protocolHash: this.protocolHash,
            startAt: this.startAt,
            asOf: now,
            durationDays,
            slotsRecorded: slotCount,
            labelsResolved: labelCount,
            openVirtualOrders: openOrders,
            pendingSettlementMarkets: pendingSettlement,
            liveTransactions: 0,
            readOnly: true,
            arms,
            health,
        };
    }

    close() {
        this.db.close();
    }
}
