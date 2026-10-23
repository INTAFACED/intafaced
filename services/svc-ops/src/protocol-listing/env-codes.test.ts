import { beforeAll, describe, expect, it } from 'vitest';

let parse: (codes: string | undefined) => { success: boolean };
beforeAll(async () => {
  // env.ts reads the process environment when it loads, so the two required secrets are set for this file only.
  process.env.EDGE_PRINCIPAL_SECRET ??= 'a-test-edge-principal-secret-long-enough';
  process.env.INTERNAL_SERVICE_SECRET ??= 'a-test-internal-service-secret-long-enough';
  const { opsEnvSchema } = await import('../env.js');
  parse = (codes) => opsEnvSchema.shape.OPS_PROTOCOL_REASON_CODES.safeParse(codes);
});

describe('OPS_PROTOCOL_REASON_CODES at boot', () => {
  it('accepts lower snake case codes with spaces around them, and a blank as unset', () => {
    expect(parse('scam_or_fraud, owner_request').success).toBe(true);
    expect(parse('').success).toBe(true);
    expect(parse(undefined).success).toBe(true);
  });

  it.each(['Scam', 'scam fraud', 'a', 'scam-or-fraud', 'ok_code,Bad'])('refuses %s instead of dropping it later', (value) => {
    expect(parse(value).success).toBe(false);
  });
});
