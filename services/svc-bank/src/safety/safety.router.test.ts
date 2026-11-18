import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { createSafetyRouter } from './safety.router.js';

// `bank.safety.transferSent` (BK-safe-02, J-bank-18 #3): svc-support asks whether the reporter sent this transfer. Only
// svc-support may ask, as a service; the answer is one boolean.

const edge = createEdgeContext({ secret: 'a-bank-scam-transfer-door-secret-32chars', serviceName: 'svc-bank' });
const ANN = '11111111-1111-4111-8111-111111111111';
const SENT = 'tr-ann-00000001';

function door() {
  const asked: [string, string][] = [];
  const safety = createSafetyRouter({
    blockedRegionNotice: () => undefined,
    transferSent: async (userId, transferId) => {
      asked.push([userId, transferId]);
      return userId === ANN && transferId === SENT;
    },
    guard: (fn) => fn(),
  });
  const call = (service: string | null, input: unknown) =>
    safety.createCaller({ ...edge({ headers: {}, id: 'req-1' }), service } as never).transferSent(input as never);
  return { asked, call };
}

describe('the scam transfer door', () => {
  it('answers svc-support with one boolean: sent for the sender, not sent for anyone or anything else', async () => {
    const { asked, call } = door();
    await expect(call('svc-support', { userId: ANN, transferId: SENT })).resolves.toEqual({ sent: true });
    await expect(call('svc-support', { userId: '22222222-2222-4222-8222-222222222222', transferId: SENT })).resolves.toEqual({
      sent: false,
    });
    await expect(call('svc-support', { userId: ANN, transferId: 'tr-nobody-0001' })).resolves.toEqual({ sent: false });
    expect(asked).toHaveLength(3);
  });

  it('serves svc-support only: another service is forbidden, no service is unauthorized, and nothing is read', async () => {
    const { asked, call } = door();
    await expect(call('svc-pay', { userId: ANN, transferId: SENT })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(null, { userId: ANN, transferId: SENT })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(call('svc-support', { userId: ANN, transferId: SENT, amount: '5' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(asked).toHaveLength(0);
  });
});
