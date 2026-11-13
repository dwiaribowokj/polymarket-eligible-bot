import dns from 'node:dns';
import net from 'node:net';

export const EARLY_PAPER_TRANSPORT = Object.freeze({
    version: 'early-paper-ipv4-first-no-family-race-v1',
    scope: 'early-paper-process-only', dnsResultOrder: 'ipv4first', autoSelectFamily: false,
    requiresReachableIPv4: true,
});

export const EARLY_PAPER_CLOCK = Object.freeze({
    version: 'early-paper-independent-clock-per-attempt-v1',
    refreshMs: 20000, validMs: 30000, timeoutMs: 3000, retries: 1,
    retryMinMs: 500, retryMaxMs: 1000, circuitFailures: 3, circuitMs: 30000,
    staleFallback: 'transport-errors-only-before-original-sample-expiry',
});

let configuration;

// IPv6 is unreachable on the paper host; Node's 250 ms family race also
// abandons viable IPv4 connections. Existing request deadlines still apply.
export function configureEarlyPaperTransport() {
    if (!configuration) {
        const previous = { dnsResultOrder: dns.getDefaultResultOrder(), autoSelectFamily: net.getDefaultAutoSelectFamily() };
        try {
            dns.setDefaultResultOrder(EARLY_PAPER_TRANSPORT.dnsResultOrder);
            net.setDefaultAutoSelectFamily(EARLY_PAPER_TRANSPORT.autoSelectFamily);
        } catch (error) {
            dns.setDefaultResultOrder(previous.dnsResultOrder);
            net.setDefaultAutoSelectFamily(previous.autoSelectFamily);
            throw error;
        }
        configuration = { previous, users: 0 };
    }
    const current = configuration;
    current.users++;
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        if (--current.users > 0) return;
        configuration = undefined;
        if (dns.getDefaultResultOrder() === EARLY_PAPER_TRANSPORT.dnsResultOrder)
            dns.setDefaultResultOrder(current.previous.dnsResultOrder);
        if (net.getDefaultAutoSelectFamily() === EARLY_PAPER_TRANSPORT.autoSelectFamily)
            net.setDefaultAutoSelectFamily(current.previous.autoSelectFamily);
    };
}
