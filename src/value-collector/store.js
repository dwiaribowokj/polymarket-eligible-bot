import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from '../restart/store.js';

const STATUSES = ['ready', 'partial', 'missed'];
const EVENTS = new Set(['started', 'stopped', 'market_failed', 'book_failed', 'label_failed', 'tick_failed',
    'clock_failed', 'btc_feed_gap', 'btc_feed_failed', 'btc_feed_connected', 'btc_opening_conflict', 'observation_failed']);
const recordObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const conditionKey = value => {
    if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value)) throw new Error('collector_condition_invalid');
    return value.toLowerCase();
};

function canonical(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (recordObject(value) && Object.getPrototypeOf(value) === Object.prototype)
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    throw new Error('collector_json_invalid');
}

function syncDirectory(directory) {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function privateDirectory(directory) {
    if (fs.existsSync(directory)) return;
    privateDirectory(path.dirname(directory));
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    syncDirectory(path.dirname(directory));
}

// A completed temporary file is linked into place without replacing any published record.
function publish(filename, value) {
    privateDirectory(path.dirname(filename));
    canonical(value);
    const bytes = `${JSON.stringify(value)}\n`;
    if (fs.existsSync(filename)) {
        if (canonical(JSON.parse(fs.readFileSync(filename, 'utf8'))) !== canonical(value))
            throw new Error('collector_record_conflict');
        return false;
    }
    const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    let created = false;
    try {
        try { fs.linkSync(temporary, filename); created = true; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (canonical(JSON.parse(fs.readFileSync(filename, 'utf8'))) !== canonical(value))
                throw new Error('collector_record_conflict');
        }
        syncDirectory(path.dirname(filename));
    } finally { fs.unlinkSync(temporary); }
    return created;
}

function marketIdentity(record) {
    if (!recordObject(record) || typeof record.slug !== 'string' || !/^btc-updown-5m-\d+$/.test(record.slug))
        throw new Error('collector_market_invalid');
    const start = Number(record.slug.slice('btc-updown-5m-'.length)) * 1000;
    if (!timestamp(start) || start % 300000 !== 0 || record.marketEnd !== start + 300000)
        throw new Error('collector_market_invalid');
    return start;
}

function validateObservation(record) {
    const start = marketIdentity(record);
    if (!timestamp(record.scheduledAt) || record.scheduledAt < start || record.scheduledAt >= record.marketEnd
        || !timestamp(record.at) || record.at < record.scheduledAt || !STATUSES.includes(record.status)
        || record.id !== `${record.slug}:${record.scheduledAt}`)
        throw new Error('collector_observation_invalid');
    if (record.conditionId != null) conditionKey(record.conditionId);
    canonical(record);
}

function validateLabel(record) {
    marketIdentity(record);
    conditionKey(record.conditionId);
    const at = record.at ?? record.observedAt;
    const payout = record.payout;
    if (!timestamp(at) || at < record.marketEnd || record.official !== true || record.source !== 'ctf_payout'
        || !Array.isArray(payout) || payout.length !== 2
        || payout.some(value => !Number.isFinite(value) || value < 0 || value > 1)
        || Math.abs(payout[0] + payout[1] - 1) > 1e-9)
        throw new Error('collector_label_invalid');
    const outcome = payout[0] === 1 && payout[1] === 0 ? 'UP'
        : payout[0] === 0 && payout[1] === 1 ? 'DOWN' : 'SPLIT';
    if (record.outcome !== outcome) throw new Error('collector_label_invalid');
    canonical(record);
}

function sameMarket(left, right) {
    if (left.slug !== right.slug || left.marketEnd !== right.marketEnd
        || conditionKey(left.conditionId) !== conditionKey(right.conditionId))
        throw new Error('collector_condition_conflict');
}

function* files(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* files(filename);
        else if (entry.isFile() && entry.name.endsWith('.json')) yield filename;
        else if (!entry.isFile() || !entry.name.endsWith('.tmp')) throw new Error('collector_storage_entry_invalid');
    }
}

export class ValueCollectorStore {
    constructor(config) {
        if (!recordObject(config) || typeof config.id !== 'string' || !config.id || !config.policy || !config.sources
            || typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir))
            throw new Error('collector_config_invalid');
        this.directory = config.dataDir;
        this.filename = path.join(this.directory, 'state.json');
        this.identity = { version: 1, id: config.id, policy: config.policy, sources: config.sources };
        canonical(this.identity);
        privateDirectory(this.directory);
        fs.chmodSync(this.directory, 0o700);
        const manifestFile = path.join(this.directory, 'manifest.json');
        if (!fs.existsSync(manifestFile)) {
            if (fs.readdirSync(this.directory).some(name => !['collector.lock', 'value-collector.lock'].includes(name) && !name.endsWith('.tmp')))
                throw new Error('collector_manifest_missing');
            publish(manifestFile, { ...this.identity, createdAt: Date.now() });
        }
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const { createdAt, ...identity } = manifest;
        if (!timestamp(createdAt) || canonical(identity) !== canonical(this.identity))
            throw new Error('collector_manifest_mismatch');
        const checkpoint = fs.existsSync(this.filename) ? JSON.parse(fs.readFileSync(this.filename, 'utf8')) : {};
        if (!recordObject(checkpoint) || Object.keys(checkpoint).length && (checkpoint.version !== 1 || checkpoint.id !== config.id))
            throw new Error('collector_state_mismatch');
        this.state = { ...checkpoint, version: 1, id: config.id, startedAt: createdAt,
            lastSlotAt: null, lastTickAt: checkpoint.lastTickAt ?? null, pending: {}, storageBytes: 0,
            counts: { observations: 0, labels: 0, statuses: { ready: 0, partial: 0, missed: 0 },
                events: checkpoint.counts?.events || {} } };
        // Records, not a potentially newer or older checkpoint cursor, determine durable coverage.
        for (const filename of files(path.join(this.directory, 'observations'))) {
            const observation = JSON.parse(fs.readFileSync(filename, 'utf8'));
            validateObservation(observation);
            if (filename !== this.observationFilename(observation)) throw new Error('collector_record_path_invalid');
            this.accountObservation(observation);
            this.state.storageBytes += fs.statSync(filename).size;
        }
        for (const filename of files(path.join(this.directory, 'labels'))) {
            const label = JSON.parse(fs.readFileSync(filename, 'utf8'));
            validateLabel(label);
            if (filename !== this.labelFilename(label.conditionId)) throw new Error('collector_record_path_invalid');
            if (!this.hasObservation(label)) throw new Error('collector_label_without_observation');
            this.state.counts.labels++;
            this.state.storageBytes += fs.statSync(filename).size;
        }
        this.save();
    }

    observationFilename(record) {
        const day = new Date(record.scheduledAt).toISOString().slice(0, 10);
        return path.join(this.directory, 'observations', day, record.slug, `${record.scheduledAt}.json`);
    }

    labelFilename(conditionId) {
        const hash = crypto.createHash('sha256').update(conditionKey(conditionId)).digest('hex');
        return path.join(this.directory, 'labels', hash.slice(0, 2), `${hash}.json`);
    }

    hasObservation(label) {
        const start = marketIdentity(label), day = new Date(start).toISOString().slice(0, 10);
        for (const filename of files(path.join(this.directory, 'observations', day, label.slug))) {
            const row = JSON.parse(fs.readFileSync(filename, 'utf8'));
            validateObservation(row);
            if (row.conditionId && conditionKey(row.conditionId) === conditionKey(label.conditionId)) {
                sameMarket(row, label);
                return true;
            }
        }
        return false;
    }

    accountObservation(record) {
        this.state.counts.observations++;
        this.state.counts.statuses[record.status]++;
        this.state.lastSlotAt = Math.max(this.state.lastSlotAt ?? 0, record.scheduledAt);
        if (record.conditionId == null) return;
        const key = conditionKey(record.conditionId), labelFile = this.labelFilename(key);
        if (fs.existsSync(labelFile)) {
            const label = JSON.parse(fs.readFileSync(labelFile, 'utf8'));
            validateLabel(label);
            sameMarket(label, record);
            return;
        }
        const pending = this.state.pending[key];
        if (pending) { sameMarket(pending, record); pending.firstObservedAt = Math.min(pending.firstObservedAt, record.at); }
        else this.state.pending[key] = { conditionId: key, slug: record.slug, marketEnd: record.marketEnd, firstObservedAt: record.at };
    }

    recordObservation(record) {
        validateObservation(record);
        if (record.conditionId != null) {
            const key = conditionKey(record.conditionId), pending = this.state.pending[key];
            if (pending) sameMarket(pending, record);
            const labelFile = this.labelFilename(key);
            if (fs.existsSync(labelFile)) sameMarket(JSON.parse(fs.readFileSync(labelFile, 'utf8')), record);
        }
        const filename = this.observationFilename(record);
        this.checkStorage(filename, record);
        const created = publish(filename, record);
        if (created) {
            this.accountObservation(record);
            this.state.storageBytes += fs.statSync(filename).size;
        }
        return created;
    }

    recordLabel(label) {
        validateLabel(label);
        const key = conditionKey(label.conditionId), pending = this.state.pending[key];
        if (pending) sameMarket(pending, label);
        else if (!this.hasObservation(label)) throw new Error('collector_label_without_observation');
        const filename = this.labelFilename(key);
        this.checkStorage(filename, label);
        const created = publish(filename, label);
        if (created) {
            this.state.counts.labels++;
            this.state.storageBytes += fs.statSync(filename).size;
        }
        delete this.state.pending[key];
        return created;
    }

    checkStorage(filename, record) {
        if (fs.existsSync(filename)) return;
        const bytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
        const maxBytes = this.identity.policy.maxStorageBytes ?? Infinity;
        const minFree = this.identity.policy.minFreeBytes ?? 0;
        const disk = fs.statfsSync(this.directory, { bigint: true });
        if (this.state.storageBytes + bytes > maxBytes
            || disk.bavail * disk.bsize < BigInt(Math.ceil(minFree + bytes)))
            throw new Error('collector_storage_budget_exhausted');
    }

    save() {
        if (this.state.id !== this.identity.id || this.state.version !== 1) throw new Error('collector_state_mismatch');
        canonical(this.state);
        atomicJson(this.filename, this.state);
    }

    event(type) {
        if (!EVENTS.has(type)) throw new Error('collector_event_invalid');
        this.state.counts.events[type] = (this.state.counts.events[type] || 0) + 1;
        this.save();
        return { at: Date.now(), type };
    }
}
