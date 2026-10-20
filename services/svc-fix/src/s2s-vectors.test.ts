import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createServiceVerifier, type Keyring } from '@intafaced/contracts';

/**
 * The cross-language vectors the Java verifier is held to (ServiceKeysTest). They were signed once by the
 * TypeScript signer with throwaway keys whose signing halves were discarded; here TypeScript must accept every one,
 * so the file cannot drift from the contracts scheme without this test or the Java test failing.
 */
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'test', 'resources', 's2s-v3-vectors.json');
const doc = JSON.parse(readFileSync(file, 'utf8')) as {
  now: number;
  self: 'svc-fix';
  keyring: { keys: Keyring };
  cases: Array<{
    name: string;
    method: string;
    target: string;
    body: string;
    headers: Record<string, string>;
    expect: { status: string; service: string; kid: string };
  }>;
};

describe('s2s v3 vectors', () => {
  it('has the cases the Java side reads', () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(doc)).not.toMatch(/PRIVATE|pkcs8|"d"\s*:/i);
  });

  it.each(doc.cases.map((c) => [c.name, c] as const))('TypeScript accepts: %s', (_name, c) => {
    const verifier = createServiceVerifier({
      self: doc.self,
      keyring: doc.keyring.keys,
      now: () => new Date(doc.now * 1000),
      bootSecond: 0,
    });
    const out = verifier.verify({
      method: c.method,
      url: c.target,
      headers: c.headers,
      rawBody: { retained: true, bytes: Buffer.from(c.body, 'utf8') },
    });
    expect(out).toEqual(c.expect);
  });
});
