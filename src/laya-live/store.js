import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from '../restart/store.js';

// Keep live I/O tuning outside the source-pinned paper control baseline.
export class LiveStore extends Store {
    save() {
        if (this.state.mode !== 'pilot') return super.save();
        fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const tmp = `${this.filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
        fs.renameSync(tmp, this.filename);
        const dir = fs.openSync(path.dirname(this.filename), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
}
