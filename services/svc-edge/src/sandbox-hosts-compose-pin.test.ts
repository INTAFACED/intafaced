/**
 * Compose passes the owner's EDGE_SANDBOX_HOSTS into svc-edge, empty when unset, and env.ts refuses a malformed entry.
 * Blank means no sandbox host, so every sandbox key is refused env.mismatch (gateway-plane.ts); compose never invents
 * a host.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sandboxHostsValid } from './gateway-plane.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function edgeServiceBlock(source: string): string {
  const match = source.match(/^  svc-edge:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m);
  if (!match) throw new Error('svc-edge service block missing from docker-compose.apps.yml');
  return match[0];
}

const SANDBOX_HOSTS = /^\s+EDGE_SANDBOX_HOSTS:\s*\$\{EDGE_SANDBOX_HOSTS:-\}\s*$/gm;

describe('EDGE_SANDBOX_HOSTS reaches svc-edge as the owner set it', () => {
  it('compose svc-edge block is an empty pass-through, once', () => {
    const block = edgeServiceBlock(readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8'));
    expect(block.match(SANDBOX_HOSTS)).toHaveLength(1);
  });

  it('.env.example names it blank', () => {
    expect(readFileSync(join(ROOT, '.env.example'), 'utf8')).toMatch(/^EDGE_SANDBOX_HOSTS=$/m);
  });

  it('env.ts refines the value with sandboxHostsValid and gives it no default', () => {
    const envTs = readFileSync(join(ROOT, 'services/svc-edge/src/env.ts'), 'utf8');
    expect(envTs).toMatch(/EDGE_SANDBOX_HOSTS: z\s*\.string\(\)\s*\.optional\(\)\s*\.refine\(sandboxHostsValid,/);
    expect(envTs).not.toMatch(/EDGE_SANDBOX_HOSTS:[\s\S]{0,200}\.default\(/);
  });

  it('blank and host[:port] lists are valid; a scheme, path, space or wildcard is not', () => {
    expect(sandboxHostsValid(undefined)).toBe(true);
    expect(sandboxHostsValid('')).toBe(true);
    expect(sandboxHostsValid('sandbox.example:443, localhost:14500,[::1]:8080, 10.0.0.2, sandbox.example.')).toBe(true);
    for (const bad of ['https://sandbox.example', 'sandbox.example/api', 'sand box.example', '*.sandbox.example', 'a.example,b c']) {
      expect(sandboxHostsValid(bad)).toBe(false);
    }
  });
});
