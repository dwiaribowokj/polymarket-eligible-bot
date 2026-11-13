import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { saveEntryFilterPaperReport } from './report.js';

const state = JSON.parse(fs.readFileSync(path.join(workerData.dataDir, workerData.id, 'ledger.json'), 'utf8'));
const report = saveEntryFilterPaperReport(workerData, state);
parentPort.postMessage({ id: report.id, generatedAt: report.generatedAt });
