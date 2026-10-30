import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The shipped entrypoint refuses to boot on a malformed `EDGE_SANDBOX_HOSTS`. A scheme or wildcard there would never
 * match a Host header, so every sandbox key would be refused while the operator believed a sandbox host was set; the
 * module-scope env parse stops that at boot instead. The rule itself, end to end through identity, is proven in the
 * running app (PR body); `gateway-plane.test.ts` holds the decision table.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(HERE, 'index.ts');

function boot(sandboxHosts: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', ENTRYPOINT], {
      cwd: join(HERE, '..'),
      env: {
        ...process.env,
        APP_ENV: 'test',
        NODE_ENV: 'test',
        SERVICE_NAME: 'svc-edge',
        HTTP_HOST: '127.0.0.1',
        HTTP_PORT: '0',
        LOG_LEVEL: 'fatal',
        OTEL_ENABLED: 'false',
        JWT_ACCESS_SECRET: 'test-only-signing-secret-at-least-32-characters-long',
        EDGE_PRINCIPAL_SECRET: 'test-only-edge-principal-secret-at-least-32-chars',
        EDGE_RATE_LIMIT_MAX: '300',
        EDGE_RATE_LIMIT_WINDOW_MS: '60000',
        EDGE_BODY_LIMIT_BYTES: '1048576',
        INTAFACED_SANCTIONS_REGIONS: 'AA:test-fixture-not-a-real-list',
        EDGE_KILL_STATE_PATH: '',
        EDGE_SANDBOX_HOSTS: sandboxHosts,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

describe('svc-edge boot with EDGE_SANDBOX_HOSTS', () => {
  it('refuses to boot on a host with a scheme', async () => {
    const { code, output } = await boot('https://sandbox.example');
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(output).toMatch(/EDGE_SANDBOX_HOSTS/);
  }, 40_000);

  it('refuses to boot on a wildcard host', async () => {
    const { code, output } = await boot('*.sandbox.example');
    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    expect(output).toMatch(/EDGE_SANDBOX_HOSTS/);
  }, 40_000);
});
