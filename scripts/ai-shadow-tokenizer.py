"""Persistent, offline token counter for the installed Laya typed-decisions input.

No torch/model inference. Mirrors laya.common.build_sequence and fails instead
of accepting any instruction/option/state truncation.
"""
import hashlib
import importlib.metadata
import json
import sys
from pathlib import Path
from tokenizers import Tokenizer

files = list(Path('/data/huggingface').rglob('typed-decisions/tokenizer/tokenizer.json'))
if len(files) != 1:
    raise RuntimeError('ambiguous_laya_tokenizer')
filename = files[0]
tokenizer = Tokenizer.from_file(str(filename))
tokenizer.no_truncation()
cfg = json.loads((filename.parent.parent / 'rl_agent_config.json').read_text())
weights = filename.parent.parent / 'model.safetensors'
base_identity = filename.read_bytes() + json.dumps(cfg, sort_keys=True).encode() + importlib.metadata.version('laya').encode()
def artifact_identity():
    stat = weights.stat()
    return hashlib.sha256(base_identity + str((stat.st_size,stat.st_mtime_ns)).encode()).hexdigest()
identity = artifact_identity()
print(json.dumps({'ready': True, 'identity': identity, 'maxTokens': cfg['max_len'],
                  'revision': str(filename).split('/snapshots/')[1].split('/')[0]}), flush=True)
def count(text):
    return len(tokenizer.encode(text.replace('[MASK]', ' '), add_special_tokens=False).ids)
for line in sys.stdin:
    try:
        body = json.loads(line)
        state = body['state']
        state_text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        head = count('choice question: ' + body['questions']['action']['instructions'])
        options = [count(' ' + k + ': ' + v) for k, v in body['questions']['action']['criteria'].items()]
        required = 4 + head + sum(1 + n for n in options) + count(state_text)
        valid = required <= cfg['max_len'] and max(options) <= 48 and head <= max(8, cfg['head_max_len'] - sum(1 + n for n in options))
        print(json.dumps({'requestId': body['requestId'], 'tokens': required, 'valid': valid,
                          'identity': artifact_identity()}), flush=True)
    except Exception:
        print(json.dumps({'requestId': None, 'valid': False, 'error': 'tokenizer_input_invalid'}), flush=True)
