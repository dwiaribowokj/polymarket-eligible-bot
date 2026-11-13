#!/usr/bin/env node
import path from 'node:path';
import { BinanceCandleHistoryCollector, readCandleHistory } from '../src/premarket-paper/candle-history.js';

const args = process.argv.slice(2), command = args.shift() || 'run';
let filename = process.env.MARKET_HISTORY_CACHE || path.resolve('data/market-history/btcusdt-5m.json');
while (args.length) {
    const option = args.shift();
    if (option !== '--cache' || !args.length) throw new Error('Usage: market-history.js run|once|status [--cache PATH]');
    filename = path.resolve(args.shift());
}
if (!['run', 'once', 'status'].includes(command)) throw new Error('Usage: market-history.js run|once|status [--cache PATH]');
const print = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (command === 'status') {
    const at = Date.now(), result = readCandleHistory(filename, { snapshotAt: at, now: at });
    const { bars, ...status } = result;
    print({ ...status, filename, barCount: bars.length });
    process.exitCode = result.ready ? 0 : 1;
} else {
    const collector = new BinanceCandleHistoryCollector({ filename }, { onEvent: print });
    const stop = () => collector.stop();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
        const status = await collector.start();
        print({ type: 'candle_history_status', filename, ...status });
        if (command === 'once') { collector.stop(); process.exitCode = status.ready ? 0 : 1; }
    } catch (error) {
        collector.stop();
        print({ type: 'candle_history_degraded', reason: /^candle_history_[a-z_]+$/.test(error?.message || '')
            ? error.message : 'candle_history_start_failed' });
        process.exitCode = 1;
    }
}
