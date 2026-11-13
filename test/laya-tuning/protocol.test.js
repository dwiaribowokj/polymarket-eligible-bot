import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { QUESTIONS } from '../../src/ai-shadow/encoding.js';
import { MODEL, PROTOCOL_VERSION, LABELS, MAX_CONTEXT_TOKENS, PROBABILITY_SUM_TOLERANCE, buildProtocolRequest,
    listProtocolVariants, verifyProtocolContext, parseProtocolResponse } from '../../src/laya-tuning/protocol.js';

const digest = text => createHash('sha256').update(text).digest('hex');
function snapshot(allowed = ['BUY_UP'], extraState = {}) {
    const input = JSON.stringify({ seconds: 60, open_usd: 84000, delta_cents: [25, 20], margin_cents: 20,
        sigma_milliusd: 1200, ret_millibps: [12, 5, -2, 3, 9], bars_cents: [[0, 30, -5, 25]],
        up: [[[54.25, 3.5]], [[55, 9]]], down: 'mirror_up', fee: [0.25, 2], shares: 5, cap_usd: 4,
        limit_cost_up_down: [[56, 2.9], null], allowed, ...extraState });
    return { snapshotId: 'persisted-snapshot', input, inputHash: digest(input),
        state: { future: 'do not send' }, outcome: 'BUY_DOWN', settlement: { price: 90000 } };
}
function response(choice = 'BUY_UP', probabilities = { BUY_UP: 0.6, BUY_DOWN: 0.15, SKIP: 0.25 }) {
    return { routing: { model: MODEL }, answers: { action: { choice, probabilities, answer_confidence: 0.92 } } };
}
function counter(overrides = {}) {
    return { async start() { return { maxTokens: MAX_CONTEXT_TOKENS, identity: 'offline-tokenizer' }; },
        async count() { return { valid: true, tokens: 1024, identity: 'offline-tokenizer', ...overrides }; } };
}

test('candidate preserves exact persisted bytes and identity without copying later snapshot values', () => {
    const s = snapshot();
    // Whitespace is significant to the persisted digest and must not be re-encoded.
    s.input = `  ${s.input}\n`;
    s.inputHash = digest(s.input);
    const p = buildProtocolRequest(s, { allowedLabels: ['BUY_UP', 'SKIP'] });
    assert.equal(p.protocolVersion, PROTOCOL_VERSION);
    assert.equal(p.request.model, MODEL);
    assert.equal(p.snapshotId, s.snapshotId);
    assert.equal(p.inputHash, s.inputHash);
    assert.equal(p.request.state, s.input);
    assert.deepEqual(Object.keys(p.request), ['model', 'state', 'questions']);
    assert.deepEqual(p.allowedLabels, ['BUY_UP', 'SKIP']);
    assert.equal(JSON.stringify(p.request).includes('do not send'), false);
    assert.equal(JSON.stringify(p.request).includes('90000'), false);
    assert.deepEqual(JSON.parse(p.request.state), JSON.parse(s.input));
});

test('fixed three choices make both buy permissions conditional and retain SKIP for any allowed set', () => {
    for (const allowed of [[], ['BUY_UP'], ['BUY_DOWN'], ['BUY_UP', 'BUY_DOWN'], ['SKIP']]) {
        const p = buildProtocolRequest(snapshot(allowed));
        const { instructions, criteria, type } = p.request.questions.action;
        assert.equal(type, 'choice');
        assert.deepEqual(Object.keys(criteria), LABELS);
        assert.match(instructions, /BUY absent there is forbidden/);
        assert.match(instructions, /SKIP is always available/);
        assert.match(criteria.BUY_UP, /only if BUY_UP is in state.allowed/);
        assert.match(criteria.BUY_DOWN, /only if BUY_DOWN is in state.allowed/);
        assert.equal(parseProtocolResponse(response('SKIP'), p).status, 'ok');
        assert.equal(parseProtocolResponse(response('SKIP'), p).executable, false);
    }
});

test('input digest, compact schema and allowed state cannot be replaced or broadened', () => {
    const s = snapshot();
    assert.throws(() => buildProtocolRequest({ ...s, input: `${s.input} ` }), /snapshot_input_hash_mismatch/);
    assert.throws(() => buildProtocolRequest({ ...s, inputHash: undefined }), /snapshot_input_hash_mismatch/);
    assert.throws(() => buildProtocolRequest({ ...s, input: { allowed: ['BUY_UP'] } }), /snapshot_input_invalid/);
    assert.throws(() => buildProtocolRequest({ ...s, snapshotId: '' }), /snapshot_input_invalid/);
    assert.throws(() => buildProtocolRequest(snapshot(['BUY_UP'], { settled_winner: 'UP' })), /schema_invalid/);
    for (const labels of [['BUY_EITHER'], ['BUY_UP', 'BUY_UP'], null])
        assert.throws(() => buildProtocolRequest(snapshot(labels)), /allowed_labels_invalid/);
    assert.throws(() => buildProtocolRequest(s, { allowedLabels: ['BUY_UP', 'BUY_DOWN'] }), /allowed_labels_mismatch/);
});

test('baseline reproduces original QUESTIONS exactly and all protocol metadata is immutable', () => {
    const original = JSON.stringify(QUESTIONS);
    const baseline = buildProtocolRequest(snapshot(), { variantId: 'baseline-v1' });
    assert.deepEqual(baseline.request.questions, QUESTIONS);
    assert.notEqual(baseline.request.questions, QUESTIONS);
    assert.throws(() => { baseline.request.questions.action.criteria.BUY_UP = 'changed'; }, TypeError);
    assert.throws(() => { baseline.optionOrder.reverse(); }, TypeError);
    assert.throws(() => { baseline.inputHash = 'changed'; }, TypeError);
    assert.equal(JSON.stringify(QUESTIONS), original);
    assert.equal(baseline.diagnostic, false);
});

test('stable candidate default is deterministic and all six permutations are explicit diagnostics', () => {
    const s = snapshot(), defaults = listProtocolVariants(), all = listProtocolVariants({ includePermutations: true });
    assert.deepEqual(defaults.map(row => row.variantId), ['baseline-v1', 'candidate-v1', 'candidate-v2']);
    assert.equal(all.length, 8);
    assert.equal(new Set(all.map(row => row.variantId)).size, 8);
    assert.equal(new Set(all.filter(row => row.promptVersion === 'allowed-actions-v1').map(row => row.optionOrder.join())).size, 6);
    const candidate = buildProtocolRequest(s);
    assert.deepEqual(candidate, buildProtocolRequest(structuredClone(s)));
    assert.equal(candidate.variantId, 'candidate-v1');
    assert.deepEqual(candidate.optionOrder, LABELS);
    assert.equal(candidate.promptHash, 'dd7d58abf149952212637d285bc51c4e057147b000de157535ab63e26d8d4e74');
    assert.equal(candidate.questionsHash, 'd06651c864b67a6d4929846a27c1145903eb63286e47f183c4f4d6530367c68a');
    const hashes = new Set();
    for (const variant of all) {
        const p = buildProtocolRequest(s, { variantId: variant.variantId, optionOrder: variant.optionOrder });
        assert.deepEqual(Object.keys(p.request.questions.action.criteria), variant.optionOrder);
        assert.equal(p.questionsHash, digest(JSON.stringify(p.request.questions)));
        assert.equal(p.requestHash, digest(JSON.stringify(p.request)));
        assert.equal(p.request.state, s.input);
        hashes.add(p.promptHash);
        assert.equal(p.diagnostic, !['baseline-v1', 'candidate-v1', 'candidate-v2'].includes(variant.variantId));
    }
    assert.equal(hashes.size, 8);
    assert.throws(() => buildProtocolRequest(s, { variantId: 'posthoc-best' }), /protocol_variant_unknown/);
    assert.throws(() => buildProtocolRequest(s, { optionOrder: ['BUY_UP', 'SKIP', 'SKIP'] }), /option_order_invalid/);
    assert.throws(() => buildProtocolRequest(s, { optionOrder: ['SKIP', 'BUY_UP', 'BUY_DOWN'] }), /variant_order_mismatch/);
});

test('compact v2 preserves feature units, conditional buys and optional SKIP with a shorter prompt', () => {
    const v1 = buildProtocolRequest(snapshot()), v2 = buildProtocolRequest(snapshot(), { variantId: 'candidate-v2' });
    const featurePrefix = QUESTIONS.action.instructions.split('Use fee-inclusive')[0];
    const { instructions, criteria } = v2.request.questions.action;
    assert.equal(v2.promptVersion, 'allowed-actions-compact-v2');
    assert.equal(instructions.startsWith(featurePrefix), true);
    assert.match(instructions, /BUY requires its label in allowed and positive fee-inclusive value/);
    assert.match(instructions, /else SKIP/);
    assert.match(instructions, /SKIP always available/);
    assert.match(instructions, /Confidence\/probabilities are not win probabilities/);
    assert.match(criteria.BUY_UP, /only if BUY_UP in allowed/);
    assert.match(criteria.BUY_DOWN, /only if BUY_DOWN in allowed/);
    assert.deepEqual(Object.keys(criteria), LABELS);
    assert.ok(JSON.stringify(v2.request.questions).length < JSON.stringify(v1.request.questions).length);
    assert.equal(v2.request.state, v1.request.state);
    assert.notEqual(v2.promptHash, v1.promptHash);
    assert.equal(buildProtocolRequest(snapshot()).variantId, 'candidate-v1');
    for (const allowed of [[], ['BUY_UP'], ['BUY_DOWN'], ['BUY_UP', 'BUY_DOWN']]) {
        const protocol = buildProtocolRequest(snapshot(allowed), { variantId: 'candidate-v2' });
        assert.equal(parseProtocolResponse(response('SKIP'), protocol).status, 'ok');
        for (const choice of ['BUY_UP', 'BUY_DOWN']) {
            const parsed = parseProtocolResponse(response(choice), protocol);
            assert.equal(parsed.status, allowed.includes(choice) ? 'ok' : 'rejected');
            assert.equal(parsed.action, allowed.includes(choice) ? choice : 'SKIP');
        }
    }
});

test('context verification passes exact candidate questions to external counter at 1024 tokens', async () => {
    const p = buildProtocolRequest(snapshot());
    let counted = false;
    const c = counter();
    c.count = async (state, questions) => {
        counted = true;
        assert.equal(state, p.request.state);
        assert.equal(questions, p.request.questions);
        return { valid: true, tokens: 1024, identity: 'offline-tokenizer' };
    };
    const evidence = await verifyProtocolContext(p, c, { expectedIdentity: 'offline-tokenizer' });
    assert.equal(counted, true);
    assert.equal(evidence.verified, true);
    assert.equal(evidence.tokens, 1024);
    assert.equal(evidence.requestHash, p.requestHash);
    assert.equal(evidence.promptHash, p.promptHash);
    assert.equal(evidence.inputHash, p.inputHash);
    assert.ok(Object.isFrozen(evidence));
});

test('missing counter, overflow, head/options truncation, guessed counts and artifact changes block context', async () => {
    const p = buildProtocolRequest(snapshot());
    await assert.rejects(verifyProtocolContext(p, null), /external_token_counter_required/);
    for (const value of [{ tokens: 1025 }, { tokens: undefined }, { tokens: 0 }, { tokens: 10.1 }, { valid: false },
        { truncated: true }, { instructionTruncated: true }, { optionsTruncated: true }, { stateTruncated: true }])
        await assert.rejects(verifyProtocolContext(p, counter(value)), /protocol_context_invalid/);
    await assert.rejects(verifyProtocolContext(p, counter({ maxTokens: 2048 })), /context_limit_mismatch/);
    await assert.rejects(verifyProtocolContext(p, { count: counter().count }), /context_limit_mismatch/);
    await assert.rejects(verifyProtocolContext(p, counter({ identity: 'new-tokenizer' })), /tokenizer_identity_mismatch/);
    await assert.rejects(verifyProtocolContext(p, counter(), { expectedIdentity: 'another-tokenizer' }), /tokenizer_identity_mismatch/);
    await assert.rejects(verifyProtocolContext({ ...p, request: { ...p.request, state: '{}' } }, counter()), /request_hash_mismatch/);
    // A stateless counter can supply its own explicit context limit and identity.
    assert.equal((await verifyProtocolContext(p, { count: counter({ maxTokens: 1024 }).count })).verified, true);
});

test('installed choice/probabilities answer preserves choice probabilities separately from confidence', () => {
    const p = buildProtocolRequest(snapshot());
    const row = parseProtocolResponse(response(), p);
    assert.equal(row.status, 'ok');
    assert.equal(row.action, 'BUY_UP');
    assert.equal(row.originalAction, 'BUY_UP');
    assert.equal(row.executable, true);
    assert.deepEqual(row.probabilities, { BUY_UP: 0.6, BUY_DOWN: 0.15, SKIP: 0.25 });
    assert.equal(row.confidence, 0.92);
    assert.equal(row.probabilityType, 'action_choice_distribution');
    assert.equal(row.confidenceType, 'answer_confidence_not_market_probability');
    assert.equal(row.snapshotId, p.snapshotId);
    assert.equal(row.inputHash, p.inputHash);
    assert.equal(row.promptHash, p.promptHash);
    assert.equal(Object.hasOwn(row, 'winProbability'), false);
});

test('a forbidden BUY is rejected, recorded and never converted into the other BUY', () => {
    for (const [allowed, choice] of [[['BUY_UP'], 'BUY_DOWN'], [['BUY_DOWN'], 'BUY_UP'], [[], 'BUY_UP']]) {
        const row = parseProtocolResponse(response(choice), buildProtocolRequest(snapshot(allowed)));
        assert.equal(row.status, 'rejected');
        assert.equal(row.reason, 'disallowed_action');
        assert.equal(row.originalAction, choice);
        assert.equal(row.action, 'SKIP');
        assert.equal(row.executable, false);
        assert.equal(row.confidence, 0.92);
        assert.equal(row.probabilities.BUY_UP, 0.6);
    }
});

test('parser preserves the typed model choice without selecting an argmax or forcing an allowed buy', () => {
    const p = buildProtocolRequest(snapshot(['BUY_UP', 'BUY_DOWN']));
    const down = parseProtocolResponse(response('BUY_DOWN', { BUY_UP: 0.7, BUY_DOWN: 0.2, SKIP: 0.1 }), p);
    assert.equal(down.status, 'ok');
    assert.equal(down.action, 'BUY_DOWN');
    assert.equal(down.probabilities.BUY_UP, 0.7);
    const skip = parseProtocolResponse(response('SKIP', { BUY_UP: 0.7, BUY_DOWN: 0.2, SKIP: 0.1 }), p);
    assert.equal(skip.status, 'ok');
    assert.equal(skip.action, 'SKIP');
    assert.equal(skip.executable, false);
});

test('three finite probabilities in range with only exact label keys are mandatory', () => {
    const p = buildProtocolRequest(snapshot());
    for (const probabilities of [undefined, null, [0.6, 0.15, 0.25], {},
        { BUY_UP: 0.6, SKIP: 0.4 }, { BUY_UP: 0.6, BUY_DOWN: 0.15, SKIP: 0.25, EXTRA: 0 },
        { BUY_UP: 0.6, BUY_DOWN: 0.4, HOLD: 0 }, { BUY_UP: '0.6', BUY_DOWN: 0.15, SKIP: 0.25 },
        { BUY_UP: NaN, BUY_DOWN: 0.15, SKIP: 0.25 }, { BUY_UP: Infinity, BUY_DOWN: 0.15, SKIP: 0.25 },
        { BUY_UP: 1.1, BUY_DOWN: 0, SKIP: -0.1 }]) {
        const raw = response();
        raw.answers.action.probabilities = probabilities;
        const parsed = parseProtocolResponse(raw, p);
        assert.equal(parsed.status, 'invalid');
        assert.equal(parsed.reason, 'probabilities_invalid');
        assert.equal(parsed.action, 'SKIP');
        assert.equal(parsed.executable, false);
        assert.equal(parsed.originalAction, 'BUY_UP');
    }
});

test('rounded choice distributions are accepted within tolerance without renormalizing', () => {
    const p = buildProtocolRequest(snapshot());
    assert.equal(PROBABILITY_SUM_TOLERANCE, 3 * 0.00005);
    for (const probabilities of [{ BUY_UP: 0.3333, BUY_DOWN: 0.3333, SKIP: 0.3333 },
        { BUY_UP: 0.3334, BUY_DOWN: 0.3334, SKIP: 0.3333 }]) {
        const row = parseProtocolResponse(response('SKIP', probabilities), p);
        assert.equal(row.status, 'ok');
        assert.deepEqual(row.probabilities, probabilities);
    }
    for (const probabilities of [{ BUY_UP: 0.3333, BUY_DOWN: 0.3333, SKIP: 0.3332 },
        { BUY_UP: 0.3334, BUY_DOWN: 0.3334, SKIP: 0.3334 },
        { BUY_UP: 0.333, BUY_DOWN: 0.333, SKIP: 0.333 },
        { BUY_UP: 0.3335, BUY_DOWN: 0.3335, SKIP: 0.3335 },
        { BUY_UP: 0.5, BUY_DOWN: 0.5, SKIP: 0.5 }]) {
        const row = parseProtocolResponse(response('SKIP', probabilities), p);
        assert.equal(row.status, 'invalid');
        assert.equal(row.reason, 'probability_sum_invalid');
    }
});

test('distinct backend confidence metrics are retained independently and optional', () => {
    const p = buildProtocolRequest(snapshot()), raw = response();
    delete raw.answers.action.answer_confidence;
    const absent = parseProtocolResponse(raw, p);
    assert.equal(absent.confidence, null);
    assert.equal(absent.answerConfidence, null);
    assert.equal(absent.entropyConfidence, null);
    assert.equal(absent.confidenceSource, null);
    raw.answers.action.confidence = 0.81;
    const entropyOnly = parseProtocolResponse(raw, p);
    assert.equal(entropyOnly.confidence, 0.81);
    assert.equal(entropyOnly.entropyConfidence, 0.81);
    assert.equal(entropyOnly.answerConfidence, null);
    assert.equal(entropyOnly.confidenceSource, 'confidence');
    assert.equal(entropyOnly.confidenceType, 'entropy_confidence_not_market_probability');
    raw.answers.action.answer_confidence = 0.92;
    raw.answers.action.confidence = 0.81;
    const both = parseProtocolResponse(raw, p);
    assert.equal(both.status, 'ok');
    assert.equal(both.confidence, 0.92);
    assert.equal(both.answerConfidence, 0.92);
    assert.equal(both.entropyConfidence, 0.81);
    assert.equal(both.confidenceSource, 'answer_confidence');
    assert.equal(both.answerConfidenceType, 'max_action_choice_probability_not_market_probability');
    assert.equal(both.entropyConfidenceType, 'entropy_based_action_confidence_not_market_probability');
});

test('invalid values in either confidence metric prevent buys even when the other metric is valid', () => {
    const p = buildProtocolRequest(snapshot());
    for (const metric of ['answer_confidence', 'confidence'])
        for (const value of [null, NaN, Infinity, -0.01, 1.01, '0.7']) {
            const raw = response();
            raw.answers.action.confidence = 0.81;
            raw.answers.action[metric] = value;
            const row = parseProtocolResponse(raw, p);
            assert.equal(row.reason, 'confidence_invalid');
            assert.equal(row.action, 'SKIP');
            assert.equal(row.executable, false);
        }
});

test('model substitution, response identity mismatches and unknown choices are invalid no-entry results', () => {
    const p = buildProtocolRequest(snapshot());
    for (const model of ['typed-decisions', 'convaiinnovations/laya-typed-decisions', 'laya-typed-decisions'])
        assert.equal(parseProtocolResponse({ ...response(), routing: { model } }, p).status, 'ok');
    assert.equal(parseProtocolResponse({ ...response(), routing: undefined, model: MODEL }, p).status, 'ok');
    for (const raw of [{ ...response(), routing: undefined }, { ...response(), routing: { model: 'other' } },
        { ...response(), model: 'other' }, { ...response(), snapshotId: 'other' },
        { ...response(), inputHash: digest('other') }, response('BUY_ANY'), {}, null]) {
        const row = parseProtocolResponse(raw, p);
        assert.equal(row.status, 'invalid');
        assert.equal(row.action, 'SKIP');
        assert.equal(row.executable, false);
    }
});

test('installed generic agent wrapper requires a typed-decisions checkpoint route', () => {
    const p = buildProtocolRequest(snapshot());
    for (const model of ['typed-decisions', 'convaiinnovations/laya-typed-decisions', 'laya-typed-decisions']) {
        const raw = { ...response(), model: 'laya-rl-agent', routing: { model } };
        raw.answers.action.confidence = 0.28;
        const row = parseProtocolResponse(raw, p);
        assert.equal(row.status, 'ok');
        assert.equal(row.model, model);
        assert.equal(row.backendModel, 'laya-rl-agent');
        assert.equal(row.answerConfidence, 0.92);
        assert.equal(row.entropyConfidence, 0.28);
    }
    for (const raw of [
        { ...response(), model: 'laya-rl-agent', routing: undefined },
        { ...response(), model: 'laya-rl-agent', routing: { model: 'other-checkpoint' } },
        { ...response(), model: 'laya-rl-agent', routing: { model: null } },
        { ...response(), model: 'other-agent-wrapper' },
        { ...response(), model: 'other-checkpoint' },
        { ...response(), model: MODEL, routing: { model: 'other-checkpoint' } }
    ]) {
        const row = parseProtocolResponse(raw, p);
        assert.equal(row.status, 'invalid');
        assert.equal(row.reason, 'model_mismatch');
        assert.equal(row.action, 'SKIP');
        assert.equal(row.executable, false);
    }
});
