import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * H3 — Real Logic SBE 1.39.0 in the svc-ws image.
 *
 * 1. Promise: compose pins INTAFACED_SBE_JAVA at the shaded jar; image target
 *    sbe-runtime ships Temurin JRE + Real Logic octets.
 * 2. Break: Node fleet image had no Java; tests stubbed utf8 and labeled it SBE.
 * 3. Done bar: docker-compose.apps.yml svc-ws target sbe-runtime and
 *    INTAFACED_SBE_JAVA: ${INTAFACED_SBE_JAVA:-/app/sbe-codec.jar}
 * 4. Paths: docker-compose.apps.yml (svc-ws) + root Dockerfile sbe-runtime
 * 5. RED: pin fails if the env key, jar path, SHA, or sbe-runtime target drop
 * 6. Nginx /ws rewrite is not recut. Not L3.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const SHA = 'e773b57cac6b';
const JAR = '/app/sbe-codec.jar';
const KEY = 'INTAFACED_SBE_JAVA';

async function loadEnv(overrides: Record<string, string | undefined> = {}) {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'test');
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  const module = await import('./env.js');
  return module.env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function wsComposeBlock(): string {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const start = compose.indexOf('\n  svc-ws:');
  expect(start, 'svc-ws service missing from docker-compose.apps.yml').toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n  svc-[a-z]+:/);
  return next === -1 ? rest : rest.slice(0, next);
}

function countAssignments(source: string, name: string): number {
  const re = new RegExp(`^\\s*${name}:`, 'gm');
  return source.match(re)?.length ?? 0;
}

describe('compose pins Real Logic SBE Java in the svc-ws image (H3)', () => {
  const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
  const block = wsComposeBlock();
  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const pin = readFileSync(join(ROOT, 'packages/sbe-codec/SBE.pin.json'), 'utf8');

  it('SBE.pin.json is Real Logic 1.39.0 SHA e773b57cac6b, not protobuf', () => {
    expect(pin).toContain('"version": "1.39.0"');
    expect(pin).toContain(SHA);
    expect(pin).toContain('aeron-io/simple-binary-encoding');
    expect(pin).toContain('uk.co.real-logic:sbe-tool:1.39.0');
    expect(pin).toContain('Protobuf-as-SBE');
    expect(pin.toLowerCase()).not.toMatch(/protobuf-as-sbe.*take/i);
  });

  it('the env loader takes INTAFACED_SBE_JAVA as optional with no invented path', async () => {
    expect((await loadEnv({ [KEY]: undefined })).INTAFACED_SBE_JAVA).toBeUndefined();
    expect((await loadEnv({ [KEY]: JAR })).INTAFACED_SBE_JAVA).toBe(JAR);
    await expect(loadEnv({ [KEY]: '' })).rejects.toThrow(/INTAFACED_SBE_JAVA/);
  });

  it('compose svc-ws builds sbe-runtime and passes the jar path once', () => {
    expect(block).toMatch(/SERVICE_NAME:\s*svc-ws/);
    expect(block).toContain('image: intafaced/svc-ws:dev');
    expect(block).toMatch(/target:\s*sbe-runtime/);
    expect(block).toMatch(new RegExp(`${KEY}:\\s*\\$\\{${KEY}:-${JAR.replace('/', '\\/')}\\}`));
    expect(countAssignments(compose, KEY)).toBe(1);
    expect(countAssignments(block, KEY)).toBe(1);
  });

  it('Dockerfile sbe-runtime copies the shaded jar and pins the SHA', () => {
    expect(dockerfile).toContain('sbe-runtime');
    expect(dockerfile).toContain('sbe-codec-0.0.0.jar');
    expect(dockerfile).toContain(JAR);
    expect(dockerfile).toContain(SHA);
    expect(dockerfile).toContain('1.39.0');
    expect(dockerfile).toContain('eclipse-temurin:21-jre-jammy');
    expect(dockerfile).toContain('SBE.pin.json');
    expect(dockerfile).toMatch(/Never protobuf/i);
    expect(dockerfile).not.toMatch(/protobuf-java|grpc-protobuf/i);
  });

  it('does not recut vendor-shell nginx /ws rewrite', () => {
    const nginxSlice = compose.slice(compose.indexOf('vendor-shell:'));
    expect(nginxSlice).toContain('nginx proxies /api to the edge and /ws to the socket');
  });
});
