import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
] as const) {
    blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
] as const) {
    blocked.addSubnet(net, bits, 'ipv6');
}

/**
 * Local development only: some sandboxes resolve every public name to a fake IP in 198.18.0.0/15 (a
 * benchmarking range). FQ_DEV_ALLOW_FAKE_IP=1 accepts that range when NOT running on the Apify platform.
 */
const DEV_FAKE_IP = process.env.FQ_DEV_ALLOW_FAKE_IP === '1' && process.env.APIFY_IS_AT_HOME !== '1';
const fakeNet = new BlockList();
fakeNet.addSubnet('198.18.0.0', 15, 'ipv4');

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
    const v = isIP(ip);
    if (v === 4) return blocked.check(ip, 'ipv4') && !(DEV_FAKE_IP && fakeNet.check(ip, 'ipv4'));
    if (v === 6) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
        if (mapped) return true; // IPv4-mapped IPv6: always refused
        return blocked.check(ip, 'ipv6');
    }
    return true; // not an IP: treat as unsafe
}

const BAD_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|arpa)$/i;

/** Syntactic checks on a user-supplied careers URL before any DNS lookup. Returns a reason or null. */
export function unsafeUrlReason(u: URL): string | null {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http(s) URLs are allowed';
    if (u.username || u.password) return 'URLs with credentials are not allowed';
    if (u.port && u.port !== '80' && u.port !== '443') return 'only ports 80 and 443 are allowed';
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host))
        return isPrivateAddress(host) ? 'private or reserved IP address' : 'IP-literal URLs are not allowed';
    if (!host.includes('.') || BAD_HOST.test(host)) return 'internal hostname';
    if (host.length > 253) return 'hostname too long';
    return null;
}
