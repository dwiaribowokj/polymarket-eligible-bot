import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { ethers } from 'ethers';
import { loadSettings, requireRuntime } from '../src/restart/config.js';
import { TradingClient, CONTRACTS, safeError } from '../src/restart/client.js';
import { atomicJson } from '../src/restart/store.js';
import { fitTemperature } from '../src/restart/calibration.js';

requireRuntime();
const args = process.argv.slice(2);
if (args.some(a => !['--collect', '--refresh-labels'].includes(a))
    || args.includes('--refresh-labels') && !args.includes('--collect'))
    throw new Error('Use node scripts/restart-calibrate.js [--collect [--refresh-labels]]');
const settings = loadSettings(), baselines = ['38758ee30d012b87', 'a3bfb5a04d5eed4e'];
const directory = path.join(settings.dataDir, 'calibration-research-2026-10-11');
const candidates = new Map(), eligible = new Map(), sources = [];
for (const baseline of baselines) {
    const filename = path.join(settings.dataDir, baseline, 'paper/late-entry.jsonl');
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
    sources.push({ baseline, eventLogSha256: hash.digest('hex') });
    const input = readline.createInterface({ input: fs.createReadStream(filename), crlfDelay: Infinity });
    for await (const line of input) {
        const r = JSON.parse(line), signal = r.signal;
        if (r.type !== 'entry_observed' || r.orders?.length !== 1 || !signal
            || signal.model !== 'chainlink_twap_brownian_research_v1' || signal.calibrated !== false
            || !Number.isFinite(signal.z) || r.quality?.reason !== null
            || ![null, 'btc_edge_insufficient'].includes(signal.reason)) continue;
        const row = { baseline, slug: r.slug, conditionId: r.conditionId, open: signal.reference.open,
            end: signal.reference.end, observedAt: r.observedAt, signal, order: r.orders[0], quality: r.quality };
        if (!candidates.has(r.conditionId)) candidates.set(r.conditionId, row);
        if (signal.reason === null && !eligible.has(r.conditionId)) eligible.set(r.conditionId, row);
    }
}
const labelsFile = path.join(directory, 'official-labels.json');
let labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, 'utf8'))
    : { source: 'official_ctf_payout', labels: {}, failures: {} };
if (args.includes('--collect')) {
    const client = new TradingClient(settings);
    try {
        const block = await client.confirmedBlock(); labels.confirmedBlock = block;
        labels.collectedAt = new Date().toISOString();
        const pending = [...candidates.values()].filter(r => args.includes('--refresh-labels') || !labels.labels[r.conditionId]);
        for (let i = 0; i < pending.length; i += 2) {
            await Promise.all(pending.slice(i, i + 2).map(async r => {
                try {
                    const payout = await client.rpc.read('calibration_payout', async (provider, blockTag) => {
                        const ctf = new ethers.Contract(CONTRACTS.conditionalTokens, [
                            'function payoutDenominator(bytes32) view returns(uint256)',
                            'function payoutNumerators(bytes32,uint256) view returns(uint256)',
                        ], provider);
                        const [denominator, ...numerators] = await Promise.all([ctf.payoutDenominator(r.conditionId, { blockTag }),
                            ...[0, 1].map(index => ctf.payoutNumerators(r.conditionId, index, { blockTag }))]);
                        return denominator.isZero() ? null : numerators.map(n => Number(n) / Number(denominator));
                    }, block, `calibration:${r.conditionId}`);
                    if (!payout) throw new Error('Official market not resolved');
                    labels.labels[r.conditionId] = { payout, block, source: 'official_ctf_payout' };
                    delete labels.failures[r.conditionId];
                } catch (error) { labels.failures[r.conditionId] = safeError(error, { stage: 'calibration_payout' }); }
            }));
            atomicJson(labelsFile, labels);
            if ((i + 2) % 20 === 0) console.log(JSON.stringify({ type: 'calibration_labels',
                labeled: Object.keys(labels.labels).length, pending: pending.length - i - 2 }));
        }
    } finally { client.close(); }
}
if (labels.source !== 'official_ctf_payout') throw new Error('Official calibration labels required');
const rows = [...eligible.values()].sort((a, b) => a.open - b.open).map(r => {
    const label = labels.labels[r.conditionId];
    if (!label || label.source !== 'official_ctf_payout' || !Array.isArray(label.payout)
        || label.payout.length !== 2 || !label.payout.every(p => [0, 1].includes(p))
        || label.payout[0] + label.payout[1] !== 1) throw new Error('Missing or nonbinary official calibration label');
    return { conditionId: r.conditionId, slug: r.slug, source: label.source, outcome: label.payout[r.order.index],
        z: r.signal.z, open: r.open, end: r.end, observedAt: r.observedAt,
        remainingSeconds: r.signal.remainingSeconds, netCostPerShare: r.signal.netCostPerShare };
});
const datasetHash = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const artifact = { schema: 1, id: 'late-twap-temperature-v4', datasetSha256: datasetHash, sources,
    scoredMarketsLabeled: candidates.size, selection: 'first_quote_valid_direction_coherent_original_signal_pass_per_market',
    ...fitTemperature(rows) };
atomicJson(path.join(directory, 'calibration-dataset.json'), rows);
atomicJson(path.join(directory, 'calibration-fit.json'), artifact);
console.log(JSON.stringify(artifact, null, 2));
