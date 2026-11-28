import { describe, expect, it } from 'vitest';
import { TRPCError } from '@intafaced/contracts';
import type { AuthService } from './auth-service.js';
import {
  ATTRIBUTION_MISSING,
  AttributionError,
  DUAL_CONTROL_MISSING,
  approvalThresholdsUnset,
  attributedSurfaces,
  attributionOnFill,
  attributionOnLedger,
  attributionOnOrder,
  fourEyes,
  installApiKeyAttribution,
  requireAttribution,
  stampAttribution,
} from './four-eyes.js';

describe('four-eyes / attribution — dual-control refuse, stamp survives', () => {
  it('policy change without a second actor refuses', () => {
    const refused = fourEyes('policy', { actorId: 'alice' });
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) expect(refused.rejected.code).toBe(DUAL_CONTROL_MISSING);
  });

  it('key change with the same actor twice refuses', () => {
    const refused = fourEyes('key', { actorId: 'alice', confirmActorId: 'alice' });
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) expect(refused.rejected.code).toBe(DUAL_CONTROL_MISSING);
  });

  it('high-risk transfer with two distinct actors applies', () => {
    const ok = fourEyes('high_risk_transfer', { actorId: 'alice', confirmActorId: 'bob' });
    expect(ok.accepted).toBe(true);
    if (ok.accepted) {
      expect(ok.actorId).toBe('alice');
      expect(ok.confirmActorId).toBe('bob');
    }
  });

  it('does not invent approval thresholds', () => {
    expect(approvalThresholdsUnset()).toBe(true);
    expect(process.env.IDENTITY_APPROVAL_THRESHOLD).toBeUndefined();
  });

  it('missing session and API-key id is a named refuse — no invented attribution', () => {
    const refused = stampAttribution({});
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) {
      expect(refused.stamp).toBeNull();
      expect(refused.rejected.code).toBe(ATTRIBUTION_MISSING);
    }
  });

  it('session id survives onto order/fill/ledger', () => {
    const stamped = stampAttribution({ sessionId: 'sess-1' });
    expect(stamped.accepted).toBe(true);
    if (!stamped.accepted) return;
    expect(attributionOnOrder(stamped.stamp).sessionId).toBe('sess-1');
    expect(attributionOnFill(stamped.stamp).sessionId).toBe('sess-1');
    expect(attributionOnLedger(stamped.stamp).sessionId).toBe('sess-1');
    expect(attributionOnOrder(stamped.stamp).apiKeyId).toBeNull();
  });

  it('API-key id survives onto order/fill/ledger', () => {
    const stamped = stampAttribution({ apiKeyId: 'key-9' });
    expect(stamped.accepted).toBe(true);
    if (!stamped.accepted) return;
    expect(attributionOnOrder(stamped.stamp).apiKeyId).toBe('key-9');
    expect(attributionOnFill(stamped.stamp).apiKeyId).toBe('key-9');
    expect(attributionOnLedger(stamped.stamp).apiKeyId).toBe('key-9');
  });

  it('requireAttribution named-refuses a signed-out caller — not empty, not degraded', () => {
    expect(() => requireAttribution({})).toThrow(AttributionError);
    try {
      requireAttribution({ sessionId: '  ', apiKeyId: '' });
    } catch (err) {
      expect(err).toBeInstanceOf(AttributionError);
      expect((err as AttributionError).code).toBe(ATTRIBUTION_MISSING);
    }
    const stamp = requireAttribution({ apiKeyId: 'key-9' });
    const surfaces = attributedSurfaces(stamp);
    expect(surfaces.order.apiKeyId).toBe('key-9');
    expect(surfaces.fill.apiKeyId).toBe('key-9');
    expect(surfaces.ledger.apiKeyId).toBe('key-9');
  });

  it('mint / exchange / assert hitch refuses a blank API-key id and does not write', async () => {
    let minted = 0;
    let exchanged = 0;
    let asserted = 0;
    const auth = {
      async createApiKey() {
        minted += 1;
        return { id: '  ', key: 'ifc_blank', prefix: 'ifc_', mode: 'live' as const };
      },
      async exchangeApiKey() {
        exchanged += 1;
        return {
          accessToken: 'tok',
          expiresAt: new Date(),
          userId: '11111111-1111-4111-8111-111111111111',
          keyId: '',
          scopes: ['trade:write'],
          mode: 'live' as const,
        };
      },
      async assertApiKeyLive() {
        asserted += 1;
        return { id: '', userId: '11111111-1111-4111-8111-111111111111' };
      },
    };
    installApiKeyAttribution(auth as unknown as AuthService);

    await expect(auth.createApiKey()).rejects.toBeInstanceOf(TRPCError);
    await expect(auth.createApiKey()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(auth.exchangeApiKey()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(auth.assertApiKeyLive()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(minted).toBe(2);
    expect(exchanged).toBe(1);
    expect(asserted).toBe(1);
  });
});
