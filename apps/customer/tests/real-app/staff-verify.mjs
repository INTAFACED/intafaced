import path from 'node:path';
import { makeContext } from '../../../../tooling/scripts/local-test-gates.mjs';
import { LOCAL_TEST_DEVICE_KEY } from '../../../../tooling/scripts/local-test-device.mjs';
import { VAULT_NAME, freshCode, identity, readVault, withLock, writePrivate } from './staff.mjs';

// Kept apart from staff.mjs on purpose: verifying a member runs the stack's two-person approval tool, so a journey that
// calls this changes the shared stack (`// World: stack`), and journeys that only sign staff in stay free of it.
/**
 * Verifies the TEST staff member of `role` at level full the way any person is verified: their own `kyc.submit`, then the
 * stack's two TEST founders approve it through identity's two-person door (`local-test-gates.mjs` approvePending). A door
 * gated by the caller's own level (svc-pay's `{ module: 'pay' }` reads) then admits them, as it admits a verified founder.
 * Already verified: nothing is sent. Call after `staffSignIn` for the role, which makes the member.
 */
export async function staffVerified(role) {
  const ctx = await makeContext({ log: () => {} });
  const file = path.join(ctx.paths.stateDir, VAULT_NAME);
  const edge = ctx.url('edge');
  const member = await withLock(file, async () => {
    const vault = readVault(file);
    const held = vault.staff[role];
    if (!held?.totpConfirmed) throw new Error(`no TEST ${role} member on this stack yet: call staffSignIn first`);
    const totpCode = await freshCode(held);
    writePrivate(file, vault);
    const session = await identity(edge, 'auth.login', {
      identifier: held.email,
      password: held.password,
      deviceKey: LOCAL_TEST_DEVICE_KEY,
      totpCode,
    });
    // A level already held answers with that approved record; a new request answers pending.
    const record = await identity(edge, 'kyc.submit', { tier: 'full', jurisdiction: 'DE' }, session.accessToken);
    return { ...held, done: record?.status === 'approved' };
  });
  if (member.done) return { userId: member.userId };
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const approved = await gates.approvePending(ctx, null, { userIds: [member.userId] });
  if (!approved.length || approved.some((r) => r.ok === false))
    throw new Error(`the TEST ${role} member's verification was not approved: ${JSON.stringify(approved).slice(0, 300)}`);
  return { userId: member.userId };
}
