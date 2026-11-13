import path from 'node:path';
import fs from 'node:fs';
import { comparison, pilotSummary } from './math.js';
import { atomicJson, pilotHistory, readTrials } from './store.js';
import { probabilityMetrics } from './calibration.js';

function calibrationReport(state, settings) {
    const observations = (state?.completed || []).filter(r => r.traded && !r.uncertain).flatMap(r => {
        const order = r.orders?.find(o => o.side === 'BUY' && o.settled > 0), signal = order?.executionSignal;
        const outcome = r.payout?.[order?.index];
        return signal && Number.isFinite(signal.z) && [0, 1].includes(outcome) ? [{ z: signal.z, outcome }] : [];
    });
    return { strategy: state?.strategy || 'late-entry', independentFilledMarkets: observations.length,
        raw: probabilityMetrics(observations), adjusted: probabilityMetrics(observations,
            settings.lateSignal?.calibration?.temperature || 1),
        eligibleForLive: false, status: 'prospective_paper_only' };
}

export function history(settings) {
    if (!fs.existsSync(settings.dataDir)) return [];
    return fs.readdirSync(settings.dataDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== settings.fingerprint)
        .flatMap(d => {
            const file = path.join(settings.dataDir, d.name, 'evaluation-report.json');
            if (!fs.existsSync(file)) return [];
            const manifestFile = path.join(settings.dataDir, d.name, 'trial-manifest.json');
            const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
            const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
            // Stored reports are snapshots; their own nested history must not grow recursively.
            delete saved.history;
            return [{ ...saved, archived: true, manifest, operationalClassification:
                manifest?.telemetrySchema ? 'classified' : 'legacy_unclassified' }];
        }).sort((a, b) => String(a.generatedAt).localeCompare(String(b.generatedAt)));
}

export function report(settings, now = Date.now(), includeHistory = false) {
    const states = readTrials(settings);
    return { ...comparison(states, settings, now), generatedAt: new Date(now).toISOString(),
        experiment: settings.experiment, parameters: { late: settings.late, lateQuality: settings.lateQuality,
            lateSignal: settings.lateSignal,
            shares: settings.shares, entryCap: settings.entryCap, capital: settings.capital,
            paperDrawdownStop: settings.paperDrawdownStop, paperShadowDrawdownStop: settings.paperShadowDrawdownStop,
            latencyMs: settings.latencyMs },
        provisional: !!settings.evaluationEndsAt && now < settings.evaluationEndsAt || states.some(s => !!s?.position),
        calibration: settings.lateSignal?.calibration ? { frozenArtifact: settings.lateSignal.calibration,
            prospective: states.map(s => calibrationReport(s, settings)) } : null,
        pilots: pilotHistory(settings).map(pilotSummary), ...(includeHistory ? { history: history(settings) } : {}) };
}

export function saveReport(settings, now = Date.now(), includeHistory = false) {
    const result = report(settings, now, includeHistory);
    const filename = path.join(settings.dataDir, settings.fingerprint, 'evaluation-report.json');
    atomicJson(filename, result);
    console.log(JSON.stringify({ type: 'evaluation_report_saved', filename,
        decision: result.decision, selected: result.selected, provisional: result.provisional }));
    return result;
}
