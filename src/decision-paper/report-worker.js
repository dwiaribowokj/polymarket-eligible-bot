import { parentPort, workerData } from 'node:worker_threads';
import { writeDecisionPaperReport } from './report.js';
const report = writeDecisionPaperReport(workerData);
parentPort.postMessage({ id: report.id, generatedAt: report.generatedAt });
