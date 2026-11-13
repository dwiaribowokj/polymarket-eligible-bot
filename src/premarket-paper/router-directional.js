import { createHash } from 'node:crypto';
import { NEXT_PROFILE, buildEarlyPremarketInput } from './early-context.js';

export const NEXT_ROUTER_DIRECTIONAL_POLICY = 'next-directional-v1';
export const NEXT_ROUTER_DIRECTIONAL_TASK = 'next-candle-directional-forecast-confirmation-v1';
export const NEXT_ROUTER_DIRECTIONAL_PROMPT_VERSION = 'next-router-directional-v1';
export const NEXT_ROUTER_DIRECTIONAL_PROMPT = [
    'You are forecasting direction for a PAPER BTC 5m experiment. This task does not require statistical proof, calibrated probabilities, or positive expected value.',
    'Valid input contains all 30 closed native Binance BTCUSDT 5m candles (150 minutes), oldest first. The target is the immediately next market after the last closed candle; decision time is target open+5s.',
    'Predict the official target closing Chainlink 60s TWAP versus its opening Chainlink 60s TWAP: closing >= opening means UP, otherwise DOWN. Official CTF payout settles. Binance is a predictive proxy, not the settlement source. Target TWAPs are normally unknown or unavailable in this snapshot; their absence alone is not a reason to abstain.',
    'Decode every compressed OHLC row accurately: values are integer cents [open-prevClose, high-open, low-open, close-open]. Start prevClose=anchor USD*100; open=prevClose+first, high=open+second, low=open+third, close=open+fourth; update prevClose=close for the next row. Divide cents by 100 for USD. These values are deltas, not absolute prices or percentages.',
    'Use all supplied history, reversal size, candle bodies and wicks, wider trend, returns, volatility, and books. Compare recent reversal strength with the preceding streak and the full window. Books list [USD/share,shares]; entries list [limit USD/share,shares,total cost USD including fees and gas]. Do not invent volume, news, future prices, or external evidence.',
    'Independently classify your best UP or DOWN forecast on valid input, even in a close call. The supplied signal and reversal hypothesis are a rule baseline that can be wrong; do not copy their direction automatically. Weigh contradictory evidence. forecastStrength is weak, moderate, or strong directional conviction, not a win probability, calibrated confidence, or an expected-value claim.',
    'After choosing forecastDirection, map it to the allowed signal: if allowed contains no BUY, action=SKIP and reasonCode=no_allowed_buy; otherwise if your forecast matches the allowed signal direction, action is that BUY_UP or BUY_DOWN and reasonCode=direction_matches_signal; otherwise action=SKIP and reasonCode=direction_opposes_signal. An opposing forecast must remain explicit even when action=SKIP. Never BUY a disallowed side.',
    'Return only one JSON object with exactly these six fields: snapshotId (copied), forecastDirection (UP|DOWN), forecastStrength (weak|moderate|strong), action (BUY_UP|BUY_DOWN|SKIP), reasonCode (direction_matches_signal|direction_opposes_signal|no_allowed_buy), rationale (concise, at most 240 characters, citing concrete supplied evidence). Do not output estimatedUpProbability, positive_edge claims, extra fields, tools, or external facts.'
].join(' ');

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw new Error(reason); };
const ACTIONS = ['BUY_UP', 'BUY_DOWN', 'SKIP'];
const FIELDS = ['snapshotId', 'forecastDirection', 'forecastStrength', 'action', 'reasonCode', 'rationale'];
const REASONS = ['direction_matches_signal', 'direction_opposes_signal', 'no_allowed_buy'];

export const routerDirectionalPolicy = config => config?.profile === NEXT_PROFILE
    && config?.routerPolicy === NEXT_ROUTER_DIRECTIONAL_POLICY;

export function routerDirectionalPromptEvidence(config) {
    return routerDirectionalPolicy(config) ? { providerTask: NEXT_ROUTER_DIRECTIONAL_TASK,
        providerPromptVersion: NEXT_ROUTER_DIRECTIONAL_PROMPT_VERSION,
        providerPromptHash: hash(NEXT_ROUTER_DIRECTIONAL_PROMPT) } : {};
}

export function normalizeRouterDirectionalResponse(raw, config, snapshot, allowed) {
    const expected = config.routerModel?.split('/').slice(1).join('/');
    if (!object(raw) || ![config.routerModel, expected].includes(raw.model)) fail('model_mismatch');
    if (!Array.isArray(raw.choices) || raw.choices.length !== 1 || raw.choices[0].finish_reason !== 'stop') fail('invalid_response');
    const message = raw.choices[0].message;
    if (!object(message) || message.role !== 'assistant' || message.refusal || message.tool_calls?.length
        || message.function_call || typeof message.content !== 'string' || message.content.length > 2048) fail('invalid_response');
    let answer;
    try { answer = JSON.parse(message.content); } catch { fail('invalid_response'); }
    if (!object(answer) || Object.keys(answer).length !== FIELDS.length
        || Object.keys(answer).some(key => !FIELDS.includes(key)) || answer.snapshotId !== snapshot.snapshotId
        || !['UP', 'DOWN'].includes(answer.forecastDirection) || !['weak', 'moderate', 'strong'].includes(answer.forecastStrength)
        || !ACTIONS.includes(answer.action) || !REASONS.includes(answer.reasonCode)
        || typeof answer.rationale !== 'string' || !answer.rationale.trim() || answer.rationale.length > 240
        || /[\u0000-\u001f]/.test(answer.rationale)) fail('invalid_response');
    // Re-derive the signal mask so a caller cannot authorize the opposite BUY.
    const derivedAllowed = buildEarlyPremarketInput(snapshot, config).allowed;
    if (!Array.isArray(allowed) || !allowed.includes(answer.action) || !derivedAllowed.includes(answer.action)) fail('disallowed_action');
    const allowedBuy = derivedAllowed.find(action => action !== 'SKIP' && allowed.includes(action));
    const matches = allowedBuy === `BUY_${answer.forecastDirection}`;
    const requiredAction = matches ? allowedBuy : 'SKIP';
    const requiredReason = !allowedBuy ? 'no_allowed_buy' : matches ? 'direction_matches_signal' : 'direction_opposes_signal';
    if (answer.action !== requiredAction || answer.reasonCode !== requiredReason) fail('router_reason_action_mismatch');
    return { action: answer.action, rawAction: answer.action, model: raw.model, confidence: null,
        forecastDirection: answer.forecastDirection, forecastStrength: answer.forecastStrength,
        forecastStrengthType: 'directional_not_calibrated', estimatedUpProbability: null,
        estimatedUpProbabilityType: 'directional_not_calibrated', reasonCode: answer.reasonCode,
        rationale: answer.rationale.trim(), expectedNetUsd: { BUY_UP: null, BUY_DOWN: null },
        responseHash: hash(message.content), responseValidation: 'strict_local_contract', upstreamSchemaEnforcement: 'unverified',
        confidenceType: 'directional_not_calibrated', usage: object(raw.usage)
            ? Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']
                .filter(key => Number.isSafeInteger(raw.usage[key]) && raw.usage[key] >= 0).map(key => [key, raw.usage[key]])) : null };
}
