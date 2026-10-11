/**
 * Production engine posture — refuse mock, unpublished, and loopback URLs at boot.
 *
 * `BLUEPRINT_ENGINE_MODE` is a switch, not a fallback. A prod process that
 * boots `mock` (or `http` pointed at localhost, or an unset URL that used to
 * invent localhost / host.docker.internal) would serve stub profiles to real
 * people and look healthy doing it.
 *
 * Local/dev stay free to use the mock. This gate is `APP_ENV=prod` only.
 * Owner may set `http://host.docker.internal:4108` explicitly — it is not loopback.
 */

export const PROD_ENGINE_CONFIG_CODE = 'blueprint.prod_engine_config' as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** True for any address in 127.0.0.0/8, including 127.0.0.2. */
function isIpv4Loopback(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const octet = Number(part);
    if (octet > 255) return false;
    octets.push(octet);
  }
  return octets[0] === 127;
}

/**
 * IPv4-mapped IPv6 loopback. Node canonicalizes `[::ffff:127.0.0.1]` to
 * hostname `::ffff:7f00:1` (127.0.0.1). The high octet of that pair is 0x7f
 * for every address in 127.0.0.0/8.
 */
function isIpv4MappedLoopback(host: string): boolean {
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!match) return false;
  const hi = Number.parseInt(match[1] ?? '', 16);
  const lo = Number.parseInt(match[2] ?? '', 16);
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff) return false;
  return hi >> 8 === 0x7f;
}

export class ProdEngineConfigError extends Error {
  readonly code = PROD_ENGINE_CONFIG_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'ProdEngineConfigError';
  }
}

export interface ProdEngineEnv {
  readonly APP_ENV: string;
  readonly BLUEPRINT_ENGINE_MODE: 'http' | 'mock';
  readonly BLUEPRINT_ENGINE_URL?: string;
}

export function isLoopbackEngineUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  // Node keeps brackets on IPv6 hostnames (`[::1]`, `[::ffff:7f00:1]`).
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  // `http://localhost.` keeps the trailing dot; it is still localhost.
  if (host === 'localhost.') return true;
  return LOOPBACK_HOSTS.has(host) || isIpv4Loopback(host) || isIpv4MappedLoopback(host);
}

export function assertProdEngine(env: ProdEngineEnv): void {
  if (env.APP_ENV !== 'prod') return;

  if (env.BLUEPRINT_ENGINE_MODE === 'mock') {
    throw new ProdEngineConfigError(
      `APP_ENV=prod refuses BLUEPRINT_ENGINE_MODE=mock (${PROD_ENGINE_CONFIG_CODE}). ` +
        `Production must reach a real Neural Engine over HTTP — mock is a local stand-in, not a fallback. ` +
        `Set BLUEPRINT_ENGINE_MODE=http and BLUEPRINT_ENGINE_URL to the engine deployment.`,
    );
  }

  if (!env.BLUEPRINT_ENGINE_URL) {
    throw new ProdEngineConfigError(
      `APP_ENV=prod refuses unset BLUEPRINT_ENGINE_URL (${PROD_ENGINE_CONFIG_CODE}). ` +
        `Blank is unpublished — will not invent http://localhost:4108 or http://host.docker.internal:4108. ` +
        `Set BLUEPRINT_ENGINE_URL to the engine deployment.`,
    );
  }

  if (isLoopbackEngineUrl(env.BLUEPRINT_ENGINE_URL)) {
    throw new ProdEngineConfigError(
      `APP_ENV=prod refuses BLUEPRINT_ENGINE_URL=${env.BLUEPRINT_ENGINE_URL} (${PROD_ENGINE_CONFIG_CODE}). ` +
        `Loopback is not a production engine. ` +
        `Set BLUEPRINT_ENGINE_URL to the engine deployment.`,
    );
  }
}
