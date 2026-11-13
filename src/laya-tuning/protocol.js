import { createHash } from 'node:crypto';
import { QUESTIONS as ORIGINAL_QUESTIONS } from '../ai-shadow/encoding.js';

// This module is deliberately separate from the production encoding/provider path.
export const MODEL = 'typed-decisions';
export const PROTOCOL_VERSION = 'laya-tuning-protocol-v1';
export const MAX_CONTEXT_TOKENS = 1024;
export const LABELS = Object.freeze(['BUY_UP', 'BUY_DOWN', 'SKIP']);
// Installed Laya rounds each of its three probabilities to four decimal places.
export const PROBABILITY_SUM_TOLERANCE = 3 * 0.00005;

const MODELS = new Set([MODEL, 'convaiinnovations/laya-typed-decisions', 'laya-typed-decisions']);
const INPUT_KEYS = new Set(['seconds', 'open_usd', 'delta_cents', 'margin_cents', 'sigma_milliusd',
    'ret_millibps', 'bars_cents', 'up', 'down', 'fee', 'shares', 'cap_usd', 'limit_cost_up_down', 'allowed']);
const CANDIDATE_PROMPT = 'BTC 5m: closing 60s Chainlink TWAP vs opening. delta_cents=[spot,TWAP]; bars_cents=oldest-first 30s OHLC offsets from open_usd. Prices/FAK limits=cents, sizes=shares; sigma=milliUSD/sqrt(s); ret=millibps for 5/15/30/60/180s. Books=[bids,asks]; mirror_up swaps Up sides using 100-price, same sizes. Respect state.allowed: a BUY absent there is forbidden. SKIP is always available. Buy only for positive fee-inclusive expected value; otherwise SKIP. Confidence and choice probabilities are not market win probabilities.';
const CANDIDATE_CRITERIA = Object.freeze({
    BUY_UP: 'Buy Up only if BUY_UP is in state.allowed and has positive value after fees.',
    BUY_DOWN: 'Buy Down only if BUY_DOWN is in state.allowed and has positive value after fees.',
    SKIP: 'No entry; choose when buys are forbidden, unprofitable or uncertain.'
});
const COMPACT_CANDIDATE_PROMPT = 'BTC 5m: closing 60s Chainlink TWAP vs opening. delta_cents=[spot,TWAP]; bars_cents=oldest-first 30s OHLC offsets from open_usd. Prices/FAK limits=cents, sizes=shares; sigma=milliUSD/sqrt(s); ret=millibps for 5/15/30/60/180s. Books=[bids,asks]; mirror_up swaps Up sides using 100-price, same sizes. BUY requires its label in allowed and positive fee-inclusive value; else SKIP. SKIP always available. Confidence/probabilities are not win probabilities.';
const COMPACT_CANDIDATE_CRITERIA = Object.freeze({
    BUY_UP: 'Closing TWAP higher; only if BUY_UP in allowed.',
    BUY_DOWN: 'Closing TWAP lower; only if BUY_DOWN in allowed.',
    SKIP: 'No entry.'
});
const ORDERS = [LABELS, ['BUY_UP', 'SKIP', 'BUY_DOWN'], ['BUY_DOWN', 'BUY_UP', 'SKIP'],
    ['BUY_DOWN', 'SKIP', 'BUY_UP'], ['SKIP', 'BUY_UP', 'BUY_DOWN'], ['SKIP', 'BUY_DOWN', 'BUY_UP']];
const orderName = order => order.map(label => label.replace('BUY_', '').toLowerCase()).join('-');
const hash = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw new Error(reason); };
function freeze(value) {
    if (value && typeof value === 'object') {
        for (const item of Object.values(value)) freeze(item);
        Object.freeze(value);
    }
    return value;
}
function validateOrder(order) {
    if (!Array.isArray(order) || order.length !== LABELS.length || new Set(order).size !== LABELS.length
        || order.some(label => !LABELS.includes(label))) fail('option_order_invalid');
    return [...order];
}
function allowedSet(labels) {
    if (!Array.isArray(labels) || new Set(labels).size !== labels.length || labels.some(label => !LABELS.includes(label)))
        fail('allowed_labels_invalid');
    return LABELS.filter(label => label === 'SKIP' || labels.includes(label));
}

/** Baseline is always explicit; permutations are diagnostics, never ranked defaults. */
export function listProtocolVariants({ includePermutations = false } = {}) {
    return freeze([
        { variantId: 'baseline-v1', promptVersion: 'original-questions-v1', optionOrder: [...LABELS], diagnostic: false },
        ...ORDERS.slice(0, includePermutations ? ORDERS.length : 1).map((order, index) => ({
            variantId: index === 0 ? 'candidate-v1' : `candidate-v1-${orderName(order)}`,
            promptVersion: 'allowed-actions-v1', optionOrder: [...order], diagnostic: index !== 0
        })),
        { variantId: 'candidate-v2', promptVersion: 'allowed-actions-compact-v2', optionOrder: [...LABELS], diagnostic: false }
    ]);
}

/** Preserve the exact persisted input; never derive state from snapshot outcome/state. */
export function buildProtocolRequest(snapshot, options = {}) {
    if (!isObject(snapshot) || typeof snapshot.snapshotId !== 'string' || !snapshot.snapshotId
        || typeof snapshot.input !== 'string') fail('snapshot_input_invalid');
    if (typeof snapshot.inputHash !== 'string' || snapshot.inputHash !== hash(snapshot.input)) fail('snapshot_input_hash_mismatch');
    let state;
    try { state = JSON.parse(snapshot.input); } catch { fail('snapshot_input_invalid'); }
    if (!isObject(state) || Object.keys(state).some(key => !INPUT_KEYS.has(key))) fail('snapshot_input_schema_invalid');
    const allowedLabels = allowedSet(state.allowed);
    if (options.allowedLabels !== undefined && JSON.stringify(allowedSet(options.allowedLabels)) !== JSON.stringify(allowedLabels))
        fail('snapshot_allowed_labels_mismatch');
    const variantId = options.variantId ?? 'candidate-v1';
    const variant = listProtocolVariants({ includePermutations: true }).find(row => row.variantId === variantId);
    if (!variant) fail('protocol_variant_unknown');
    const optionOrder = validateOrder(options.optionOrder ?? variant.optionOrder);
    // Keep named variants unambiguous: an explicit order must match its stable ID.
    if (JSON.stringify(optionOrder) !== JSON.stringify(variant.optionOrder)) fail('protocol_variant_order_mismatch');
    const compact = variantId === 'candidate-v2';
    const criteria = compact ? COMPACT_CANDIDATE_CRITERIA : CANDIDATE_CRITERIA;
    const questions = variantId === 'baseline-v1' ? structuredClone(ORIGINAL_QUESTIONS) : {
        action: { type: 'choice', instructions: compact ? COMPACT_CANDIDATE_PROMPT : CANDIDATE_PROMPT,
            criteria: Object.fromEntries(optionOrder.map(label => [label, criteria[label]])) }
    };
    const request = { model: MODEL, state: snapshot.input, questions };
    const questionsHash = hash(JSON.stringify(questions));
    const promptHash = hash(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, variantId,
        promptVersion: variant.promptVersion, questions }));
    return freeze({ protocolVersion: PROTOCOL_VERSION, variantId, promptVersion: variant.promptVersion,
        diagnostic: variant.diagnostic, snapshotId: snapshot.snapshotId, inputHash: snapshot.inputHash,
        allowedLabels, optionOrder, questionsHash, promptHash, requestHash: hash(JSON.stringify(request)), request });
}

/** The injected counter must count this exact state AND these exact questions offline. */
export async function verifyProtocolContext(protocol, counter, { expectedIdentity } = {}) {
    if (!protocol?.request || protocol.requestHash !== hash(JSON.stringify(protocol.request))) fail('protocol_request_hash_mismatch');
    if (typeof counter?.count !== 'function') fail('external_token_counter_required');
    const info = typeof counter.start === 'function' ? await counter.start() : null;
    const counted = await counter.count(protocol.request.state, protocol.request.questions);
    if (!isObject(counted) || counted.valid !== true || !Number.isInteger(counted.tokens) || counted.tokens < 1
        || counted.tokens > MAX_CONTEXT_TOKENS || counted.truncated === true || counted.instructionTruncated === true
        || counted.optionsTruncated === true || counted.stateTruncated === true) fail('protocol_context_invalid');
    const maxTokens = counted.maxTokens ?? info?.maxTokens;
    if (maxTokens !== MAX_CONTEXT_TOKENS || info?.maxTokens !== undefined && info.maxTokens !== MAX_CONTEXT_TOKENS)
        fail('protocol_context_limit_mismatch');
    const identity = counted.identity;
    if (typeof identity !== 'string' || !identity || info?.identity !== undefined && identity !== info.identity
        || expectedIdentity !== undefined && identity !== expectedIdentity) fail('protocol_tokenizer_identity_mismatch');
    return freeze({ valid: true, verified: true, tokens: counted.tokens, maxTokens, identity,
        snapshotId: protocol.snapshotId, inputHash: protocol.inputHash, promptHash: protocol.promptHash,
        questionsHash: protocol.questionsHash, requestHash: protocol.requestHash });
}

/** Invalid/disallowed choices are auditable no-entry results, never another BUY. */
export function parseProtocolResponse(raw, protocol) {
    const originalAction = typeof raw?.answers?.action?.choice === 'string' ? raw.answers.action.choice : null;
    const base = { protocolVersion: protocol.protocolVersion, variantId: protocol.variantId,
        promptVersion: protocol.promptVersion, snapshotId: protocol.snapshotId, inputHash: protocol.inputHash,
        promptHash: protocol.promptHash, questionsHash: protocol.questionsHash, requestHash: protocol.requestHash,
        originalAction, action: 'SKIP', status: 'invalid', executable: false, reason: null,
        model: null, backendModel: null, probabilities: null, confidence: null, confidenceSource: null,
        answerConfidence: null, entropyConfidence: null,
        probabilityType: 'action_choice_distribution', confidenceType: null,
        answerConfidenceType: 'max_action_choice_probability_not_market_probability',
        entropyConfidenceType: 'entropy_based_action_confidence_not_market_probability' };
    const invalid = reason => freeze({ ...base, reason });
    if (!isObject(raw)) return invalid('response_invalid');
    const routedModel = raw.routing?.model;
    // The installed server reports a generic agent wrapper at top level; only a
    // valid typed-decisions route can establish checkpoint identity for that case.
    if (routedModel !== undefined) {
        if (!MODELS.has(routedModel) || raw.model !== undefined && raw.model !== 'laya-rl-agent' && !MODELS.has(raw.model))
            return invalid('model_mismatch');
    } else if (!MODELS.has(raw.model)) return invalid('model_mismatch');
    base.model = routedModel ?? raw.model;
    base.backendModel = raw.model ?? null;
    if (raw.snapshotId !== undefined && raw.snapshotId !== protocol.snapshotId) return invalid('snapshot_mismatch');
    if (raw.inputHash !== undefined && raw.inputHash !== protocol.inputHash) return invalid('input_hash_mismatch');
    const answer = raw.answers?.action;
    if (!isObject(answer) || !LABELS.includes(originalAction)) return invalid('choice_invalid');
    const probabilities = answer.probabilities;
    if (!isObject(probabilities) || Object.keys(probabilities).length !== LABELS.length
        || Object.keys(probabilities).some(key => !LABELS.includes(key))
        || LABELS.some(key => !Object.hasOwn(probabilities, key) || !Number.isFinite(probabilities[key])
            || probabilities[key] < 0 || probabilities[key] > 1)) return invalid('probabilities_invalid');
    const sum = LABELS.reduce((total, label) => total + probabilities[label], 0);
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE + Number.EPSILON * 4) return invalid('probability_sum_invalid');
    // These are distinct backend metrics: max class probability and entropy-based
    // certainty. Both can be present and normally differ; neither is win probability.
    for (const confidence of [answer.answer_confidence, answer.confidence])
        if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1))
            return invalid('confidence_invalid');
    base.probabilities = Object.fromEntries(LABELS.map(label => [label, probabilities[label]]));
    base.answerConfidence = answer.answer_confidence ?? null;
    base.entropyConfidence = answer.confidence ?? null;
    if (answer.answer_confidence !== undefined) {
        base.confidence = answer.answer_confidence;
        base.confidenceSource = 'answer_confidence';
        base.confidenceType = 'answer_confidence_not_market_probability';
    } else if (answer.confidence !== undefined) {
        base.confidence = answer.confidence;
        base.confidenceSource = 'confidence';
        base.confidenceType = 'entropy_confidence_not_market_probability';
    }
    if (!protocol.allowedLabels.includes(originalAction)) return freeze({ ...base, status: 'rejected', reason: 'disallowed_action' });
    return freeze({ ...base, action: originalAction, status: 'ok', executable: originalAction !== 'SKIP' });
}
