import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPortalMock } from './portal.mock.mjs';

/**
 * The stand-in must answer every procedure a page can call. A page that calls a procedure nothing answers shows a
 * "not available" error in the preview, and a read or write that the real service has but the stand-in lacks goes
 * unnoticed until someone clicks it (a refund and a new payment link did exactly that). This test reads the source of
 * every page, collects each procedure name it sends, and fails for any name the stand-in does not answer.
 */
const here = new URL('.', import.meta.url).pathname;
const payRoot = join(here, '..');
const NAMESPACES =
  'merchant|merchantOps|merchantControl|merchantMetrics|merchantAnalytics|payment|settlement|subscription|mandate|submerchant|submerchantPermission|conversion|payHalts|apiKeys';
const SINGLES =
  'railHealth|setApiKeyRequestSigning|rotateSigningSecret|bindApiKeyIpAllowlist|unbindApiKeyIpAllowlist|listSessions|revokeSession';
const NAME = new RegExp(`'((?:${NAMESPACES})(?:\\.[A-Za-z0-9]+)+|${SINGLES})'`, 'g');

/** Quoted words that look like a procedure but are not one, each with the reason. */
const NOT_PROCEDURES: Record<string, string> = {
  'settlement.opened': 'a kind of settlement event shown on a timeline',
  'settlement.posted': 'a kind of settlement event shown on a timeline',
  'settlement.included': 'a kind of settlement event shown on a timeline',
  'settlement.released': 'a kind of settlement event shown on a timeline',
  'team.manage': 'a permission name, not a call',
  'team.read': 'a permission name, not a call',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.|contract-cases|copy|\.d\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every procedure name the pages send, with the files that send it. */
function calledProcedures(): Map<string, string[]> {
  const files = [
    ...sources(here),
    join(payRoot, 'merchant-refund-api.ts'),
    join(payRoot, 'pay-api.ts'),
    join(payRoot, 'MerchantBilling.tsx'),
    join(payRoot, '..', 'account', 'IdentitySessions.tsx'),
  ];
  const found = new Map<string, string[]>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(NAME)) {
      const name = match[1]!;
      if (name in NOT_PROCEDURES) continue;
      found.set(name, [...(found.get(name) ?? []), relative(payRoot, file)]);
    }
  }
  return found;
}

/** Ask the stand-in for a procedure with an empty input. A handler that exists may still throw on the empty input. */
async function answered(procedure: string): Promise<boolean> {
  const mock = createPortalMock('active');
  let status = 0;
  let body = '';
  const route = {
    request: () => ({
      url: () => `http://stand-in.test/api/pay/trpc/${procedure}`,
      method: () => 'POST',
      postDataJSON: () => ({}),
    }),
    fulfill: async (r: { status?: number; body: string }) => {
      status = r.status ?? 200;
      body = r.body;
    },
  };
  try {
    await mock.handle(route);
  } catch {
    return true;
  }
  return !(status === 404 && /No procedure/.test(body));
}

describe('the stand-in answers every procedure a page calls', () => {
  const procedures = calledProcedures();
  it('finds the calls it is meant to guard', () => {
    // If the scan itself breaks, an empty list would make the real check below pass for the wrong reason.
    for (const known of ['payment.refund', 'merchant.createLink', 'merchant.deactivateLink', 'subscription.create', 'mandate.create'])
      expect([...procedures.keys()], known).toContain(known);
    expect(procedures.size).toBeGreaterThan(80);
  });
  // Starts the stand-in once per procedure, which takes longer than the default on a shared CI runner.
  it('has an answer for each one', async () => {
    const missing: string[] = [];
    for (const [procedure, files] of procedures) if (!(await answered(procedure))) missing.push(`${procedure} (called from ${files[0]})`);
    expect(missing).toEqual([]);
  }, 60_000);
});
