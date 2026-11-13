import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { saveFilterPaperReport } from './report.js';

const config = workerData;
const state = JSON.parse(fs.readFileSync(path.join(config.dataDir, config.id, 'ledger.json'), 'utf8'));
const report = saveFilterPaperReport(config, state);
parentPort.postMessage({ id: report.id, generatedAt: report.generatedAt });
