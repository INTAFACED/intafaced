import { describe, expect, it, vi } from 'vitest';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { createPayMerchantEmailInviteClaimer } from './merchant-email-invite-claim.js';

const SECRET = 'identity-email-claim-test-secret-0123456789';

describe('pay merchant email invite claimer', () => {
  it('posts the stored mailbox as svc-identity and does not put a refusal body in the error', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(String(_url)).toBe('http://pay.test/internal/merchant-team/claim-email-invites');
      const body = String(init?.body);
      expect(body).toBe('{"userId":"11111111-1111-4111-8111-111111111111","email":"Ada@Example.com"}');
      const headers = init?.headers as Record<string, string>;
      expect(
        verifyServiceHeaders(headers, SECRET, { rawBody: { retained: true, bytes: Buffer.from(body) }, mode: 'require' }).service,
      ).toBe('svc-identity');
      return new Response(JSON.stringify({ error: 'pay.team_email_invalid', email: 'Ada@Example.com' }), { status: 400 });
    });
    const claimer = createPayMerchantEmailInviteClaimer('http://pay.test', SECRET, fetchImpl as typeof fetch);
    await expect(claimer.claim({ userId: '11111111-1111-4111-8111-111111111111', email: 'Ada@Example.com' })).rejects.toThrow(
      'merchant email invite claim refused',
    );
  });
});
