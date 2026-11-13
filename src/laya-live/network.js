import { classifyError, safeError as baseSafeError } from '../restart/network.js';

const rpcReasons = new Set(['rate_limit', 'execution_reverted', 'invalid_request', 'invalid_params',
    'method_unavailable', 'authentication', 'block_unavailable', 'upstream_unavailable', 'internal_error', 'unknown',
    'log_range_limit']);
const rpcMethods = new Set(['eth_chainId', 'net_version', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
    'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_call',
    'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount', 'eth_getStorageAt', 'eth_getLogs']);

export function safeError(error, detail = {}) {
    const result = baseSafeError(error, detail), e = classifyError(error);
    if (Number.isSafeInteger(e.rpcCode)) result.rpcCode = e.rpcCode;
    if (rpcReasons.has(e.rpcReason)) result.rpcReason = e.rpcReason;
    if (rpcMethods.has(e.rpcMethod)) result.rpcMethod = e.rpcMethod;
    return result;
}
