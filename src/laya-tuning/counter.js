import { TokenCounter } from '../ai-shadow/providers.js';

// Reuse the offline tokenizer worker, but always count the experiment's actual
// questions instead of production QUESTIONS. This does not perform inference.
export class ProtocolCounter extends TokenCounter {
    async count(state, questions) {
        await this.start();
        const requestId = ++this.serial;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('tokenizer_timeout')); }, 1000);
            this.pending.set(requestId, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ requestId, state, questions }) + '\n');
        });
    }
}
