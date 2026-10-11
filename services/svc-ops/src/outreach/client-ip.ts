import { BlockList, isIP } from 'node:net';
import { OutreachError } from './config.js';

function canonicalIp(value: string): string | null {
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6 || value.includes('%')) return null;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1]!, 16),
    low = Number.parseInt(mapped[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

/** Only a configured socket peer may supply the edge's overwritten dedicated IP header. */
export function createClientIpResolver(
  configuration?: string,
): (peer: string | undefined, clientIp: string | string[] | undefined) => string {
  const trusted = new BlockList();
  if (configuration !== undefined && configuration.trim() !== '') {
    const entries = configuration.split(',');
    if (entries.length > 100) throw new OutreachError('ops.crm.proxy_configuration_invalid');
    for (const entry of entries) {
      const cidr = entry.trim();
      const split = cidr.lastIndexOf('/');
      if (split < 1) throw new OutreachError('ops.crm.proxy_configuration_invalid');
      const address = cidr.slice(0, split),
        prefix = cidr.slice(split + 1);
      const family = isIP(address);
      if (!family || address.includes('%') || !/^(0|[1-9]\d*)$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) {
        throw new OutreachError('ops.crm.proxy_configuration_invalid');
      }
      try {
        trusted.addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
      } catch {
        throw new OutreachError('ops.crm.proxy_configuration_invalid');
      }
    }
  }
  return (peer, forwarded) => {
    const peerIp = typeof peer === 'string' ? canonicalIp(peer) : null;
    if (!peerIp) throw new OutreachError('ops.crm.client_ip_unavailable');
    // BlockList matches IPv4-mapped IPv6 peers against their IPv4 subnet too.
    const family = isIP(peer!);
    const isTrusted = trusted.check(peer!, family === 4 ? 'ipv4' : 'ipv6');
    if (!isTrusted || forwarded === undefined) return peerIp;
    if (typeof forwarded !== 'string' || forwarded.length > 45) throw new OutreachError('ops.crm.client_ip_invalid');
    const clientIp = canonicalIp(forwarded);
    if (!clientIp) throw new OutreachError('ops.crm.client_ip_invalid');
    return clientIp;
  };
}
