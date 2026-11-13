import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('eligible-live monitor preserves baselines and validates runtime identity', () => {
    const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_cron_check_polymarket.py'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        encoding: 'utf8', timeout: 15000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
});
