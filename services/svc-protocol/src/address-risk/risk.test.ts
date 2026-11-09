import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { highestReputation, MemoryAddressRiskStore, readAddressRisk, reportKey, submitReport } from './risk.js';

const SECRET = 'a-protocol-address-risk-test-edge-secret';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '33333333-3333-4333-8333-333333333333';
const CHAIN_ID = 84532;
const SUSPECT = '0x000000000000000000000000000000000000bad0' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-protocol' });

function signedIn(userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  return edge({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}
const signedOut = () => edge({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-public' });

function caller(store: MemoryAddressRiskStore, ctx = signedOut()) {
  const deps = {
    chain: { config: { chainId: CHAIN_ID, factory: ZERO, implementation: ZERO }, isDeployed: async () => false },
    registry: { accountsOf: async () => [] },
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
    addressRisk: { store, screeningLoaded: () => false },
  } as unknown as ProtocolRouterDeps;
  return createProtocolRouter(deps).createCaller(ctx);
}

describe('address risk card and scam reports (D-developer-compliance-01)', () => {
  it('with no screening source, says the list is not loaded and never "clear"; no label reads UNKNOWN', async () => {
    const risk = await caller(new MemoryAddressRiskStore()).addressRisk.read({ address: SUSPECT });
    expect(risk.screening).toEqual({ status: 'not_loaded', code: 'vendor.aml' });
    expect(risk.reputation).toBe('UNKNOWN');
    expect(risk.labels).toEqual([]);
    expect(risk.openReports).toBe(0);
  });

  it('shows a published label with its reason, and the highest reputation among the labels', async () => {
    const store = new MemoryAddressRiskStore();
    const label = (reputation: 'OK' | 'UNSAFE', kind: 'name' | 'phishing') => ({
      kind,
      value: kind === 'name' ? 'TEST name' : 'TEST phishing',
      source: 'curator' as const,
      reputation,
      reason: `TEST reason for ${kind}`,
      evidenceUrl: null,
      version: 1,
      setAt: new Date('2026-11-07T00:00:00Z'),
    });
    store.addLabel(CHAIN_ID, SUSPECT, label('OK', 'name'));
    store.addLabel(CHAIN_ID, SUSPECT, label('UNSAFE', 'phishing'));
    const risk = await readAddressRisk(store, { chainId: CHAIN_ID, address: SUSPECT, screeningLoaded: false });
    expect(risk.reputation).toBe('UNSAFE');
    expect(risk.labels.map((l) => l.reason)).toEqual(['TEST reason for name', 'TEST reason for phishing']);
    // Another chain's labels are not this address's.
    expect((await readAddressRisk(store, { chainId: 1, address: SUSPECT, screeningLoaded: false })).labels).toEqual([]);
    expect(highestReputation([])).toBe('UNKNOWN');
  });

  it('a signed-in report is received; a second by the same person is refused as a duplicate; the public sees a count only', async () => {
    const store = new MemoryAddressRiskStore();
    const alice = caller(store, signedIn(ALICE));
    const receipt = await alice.addressReports.submit({ address: SUSPECT, kind: 'scam', note: 'TEST: asked me for my phrase' });
    expect(receipt.kind).toBe('scam');
    await expect(alice.addressReports.submit({ address: SUSPECT, kind: 'scam' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/^protocol\.reports\.duplicate:/),
    });
    // The same address in another case is the same address.
    await expect(
      alice.addressReports.submit({ address: SUSPECT.toUpperCase().replace('0X', '0x'), kind: 'phishing' }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await caller(store, signedIn(BOB)).addressReports.submit({ address: SUSPECT, kind: 'phishing' });
    const risk = await caller(store).addressRisk.read({ address: SUSPECT });
    expect(risk.openReports).toBe(2);
    const wire = JSON.stringify(risk);
    expect(wire).not.toContain(ALICE);
    expect(wire).not.toContain('asked me for my phrase');
    // The queue keeps who reported, by the business key.
    expect(store.reports.map((r) => r.idempotencyKey)).toEqual([reportKey(ALICE, CHAIN_ID, SUSPECT), reportKey(BOB, CHAIN_ID, SUSPECT)]);
  });

  it('a signed-out visitor cannot report', async () => {
    await expect(caller(new MemoryAddressRiskStore()).addressReports.submit({ address: SUSPECT, kind: 'scam' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses an evidence link that is not http(s) and keeps nothing', async () => {
    const store = new MemoryAddressRiskStore();
    await expect(
      submitReport(store, { chainId: CHAIN_ID, reporterId: ALICE, address: SUSPECT, kind: 'scam', evidenceUrl: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ code: 'protocol.reports.evidence_invalid' });
    expect(store.reports).toHaveLength(0);
  });
});
