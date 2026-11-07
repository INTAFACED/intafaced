import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { Principal } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createFounderAuthority } from '../founder-authority.js';
import { createMerchantOpsRouter, type MerchantOpsDeps } from './router.js';
import { claimEmailTeamInvites } from './team-email-claim.js';
import { MerchantOpsError } from './errors.js';
import type { TeamInviteMail } from './team-invite-mail.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_team_email_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const id = () => randomUUID();
const LIMIT = { maxPerWindow: 2, windowMs: 60_000, ttlMs: 86_400_000 };
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };

const principalOf = (userId: string, over: Partial<Principal> = {}): Principal => ({
  userId,
  sub: userId,
  sid: id(),
  scopes: ['pay:read', 'pay:write'],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 600_000),
  ...over,
});
const ctxOf = (principal: Principal): Context => ({ principal, service: null, region: 'DE', requestId: id() });

async function refusal(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    const err = e as { cause?: { code?: string } };
    return err.cause?.code ?? (e as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('merchant email team invites', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  const owner = id();
  let merchant = '';

  const founderFetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
  const founderAuthority = createFounderAuthority({ ...identity, fetcher: founderFetcher });
  /** Every invitation mail the service wrote, as the LOCAL-TEST outbox would hold it. */
  const sent: Array<Parameters<TeamInviteMail['send']>[0]> = [];
  const teamInviteMail: TeamInviteMail = { send: async (message) => void sent.push(message) };
  const deps = (): MerchantOpsDeps => ({ sql, founderAuthority, teamEmailInvite: LIMIT, teamInviteMail });
  const roomy = (): MerchantOpsDeps => ({ ...deps(), teamEmailInvite: { ...LIMIT, maxPerWindow: 10 } });
  const lastCode = (memberId: string) => sent.filter((m) => m.memberId === memberId).at(-1)!.code;
  const as = (userId: string, over: Partial<Principal> = {}, routerDeps: MerchantOpsDeps = deps()) =>
    createMerchantOpsRouter(routerDeps).createCaller(ctxOf(principalOf(userId, over)));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  it('returns the same shape for any mailbox and does not store an account id', async () => {
    const first = await as(owner, {}, roomy()).merchantOps.team.invite({ email: '  Ada@Example.COM ', role: 'viewer', label: 'Ada' });
    const second = await as(owner, {}, roomy()).merchantOps.team.invite({ email: 'nobody-not-a-user@example.com', role: 'finance' });
    expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
    expect(first).toMatchObject({ status: 'invited', role: 'viewer', userId: 'email:ada@example.com', label: 'Ada' });
    expect(second).toMatchObject({ status: 'invited', role: 'finance', userId: 'email:nobody-not-a-user@example.com' });
    expect(first.userId).not.toMatch(/^[0-9a-f]{8}-/);
    expect(second.userId).not.toMatch(/^[0-9a-f]{8}-/);
    const again = await as(owner, {}, roomy()).merchantOps.team.invite({ email: 'ada@example.com', role: 'developer' });
    expect(again).toMatchObject({ memberId: first.memberId, userId: 'email:ada@example.com', role: 'developer', status: 'invited' });
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_team_members WHERE merchant_id = ${merchant} AND user_id LIKE 'email:%'`;
    expect(rows[0]?.n).toBe(2);
  });

  it('refuses an unset window, a reserved account id, a bad mailbox, and both targets', async () => {
    const off = await refusal(() =>
      as(owner, {}, { sql, founderAuthority }).merchantOps.team.invite({ email: 'ada@example.com', role: 'viewer' }),
    );
    expect(off).toBe('pay.team_email_invite_unconfigured');
    // Email off: the window is published but no transport is set. Refused, and nothing is stored.
    const noMail = await refusal(() =>
      as(owner, {}, { sql, founderAuthority, teamEmailInvite: LIMIT }).merchantOps.team.invite({
        email: 'mail-off@example.com',
        role: 'viewer',
      }),
    );
    expect(noMail).toBe('pay.team_email_invite_unconfigured');
    const kept = await sql`SELECT 1 FROM pay.merchant_team_members WHERE user_id = 'email:mail-off@example.com'`;
    expect(kept).toHaveLength(0);
    expect(await refusal(() => as(owner).merchantOps.team.invite({ userId: 'email:ada@example.com', role: 'viewer' }))).toBe(
      'pay.team_user_id_reserved',
    );
    expect(await refusal(() => as(owner).merchantOps.team.invite({ email: 'not-an-email', role: 'viewer' }))).toBe(
      'pay.team_email_invalid',
    );
    expect(await refusal(() => as(owner).merchantOps.team.invite({ userId: id(), email: 'ada@example.com', role: 'viewer' }))).toBe(
      'pay.team_invite_target_invalid',
    );
    expect(await refusal(() => as(owner).merchantOps.team.invite({ role: 'viewer' }))).toBe('pay.team_invite_target_invalid');
  });

  it('keeps the role checks: a viewer cannot invite, an admin cannot grant admin, a key cannot', async () => {
    const viewer = id();
    const invited = await as(owner).merchantOps.team.invite({ userId: viewer, role: 'viewer' });
    await as(viewer).merchantOps.team.acceptInvite({ memberId: invited.memberId! });
    expect(await refusal(() => as(viewer).merchantOps.team.invite({ email: 'new@example.com', role: 'viewer' }))).toBe(
      'pay.team_role_forbidden',
    );
    const admin = id();
    const adminInvite = await as(owner).merchantOps.team.invite({ userId: admin, role: 'admin' });
    await as(admin).merchantOps.team.acceptInvite({ memberId: adminInvite.memberId! });
    expect(await refusal(() => as(admin).merchantOps.team.invite({ email: 'boss@example.com', role: 'admin' }))).toBe(
      'pay.team_role_forbidden',
    );
    expect(
      await refusal(() => as(owner, { kid: 'ifc_live_key' }).merchantOps.team.invite({ email: 'key@example.com', role: 'viewer' })),
    ).toBe('pay.team_interactive_only');
  });

  it('rate-limits new email invites per merchant and does not count an account-id invite', async () => {
    const tight = id();
    const merchantId = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${tight}) RETURNING id`)[0]!.id;
    const caller = as(tight);
    await caller.merchantOps.team.invite({ userId: id(), role: 'viewer' });
    await caller.merchantOps.team.invite({ email: 'one@example.com', role: 'viewer' });
    await caller.merchantOps.team.invite({ email: 'two@example.com', role: 'viewer' });
    expect(await refusal(() => caller.merchantOps.team.invite({ email: 'three@example.com', role: 'viewer' }))).toBe(
      'pay.team_email_invite_rate_limited',
    );
    const stored = await sql<Array<{ user_id: string }>>`
      SELECT user_id FROM pay.merchant_team_members WHERE merchant_id = ${merchantId} AND user_id LIKE 'email:%' ORDER BY user_id`;
    expect(stored.map((row) => row.user_id)).toEqual(['email:one@example.com', 'email:two@example.com']);
  });

  it('binds a pending email invite and leaves it invited until acceptInvite', async () => {
    const host = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${host})`;
    const invited = await as(host).merchantOps.team.invite({ email: 'join@example.com', role: 'developer', label: 'Jo' });
    expect(invited.userId).toBe('email:join@example.com');
    const person = id();
    const first = await claimEmailTeamInvites(sql, { userId: person, email: 'Join@Example.com' }, LIMIT.ttlMs);
    expect(first).toEqual({ claimed: 1, accepted: 0 });
    const row = await sql<Array<{ user_id: string; status: string; role: string }>>`
      SELECT user_id, status, role FROM pay.merchant_team_members WHERE id = ${invited.memberId}`;
    expect(row[0]).toMatchObject({ user_id: person, status: 'invited', role: 'developer' });
    const listed = await as(host).merchantOps.team.list({ limit: 20 });
    expect(listed.items.find((member) => member.memberId === invited.memberId)).toMatchObject({
      userId: 'email:join@example.com',
      status: 'invited',
      label: 'Jo',
    });
    expect(JSON.stringify(listed)).not.toContain(person);
    const byAccount = await as(host).merchantOps.team.list({ limit: 20, search: person });
    expect(byAccount.items.find((member) => member.memberId === invited.memberId)).toBeUndefined();
    const byEmail = await as(host).merchantOps.team.list({ limit: 20, search: 'email:join@example.com' });
    expect(byEmail.items.find((member) => member.memberId === invited.memberId)?.userId).toBe('email:join@example.com');
    await as(host).merchantOps.team.changeRole({ memberId: invited.memberId!, role: 'viewer' });
    const trail = await as(host).merchantOps.team.history({ limit: 20 });
    expect(JSON.stringify(trail)).not.toContain(person);
    expect(trail.items.some((event) => event.action === 'role_changed' && event.memberUserId === 'email:join@example.com')).toBe(true);
    const invitations = await as(person).merchantOps.team.myInvitations({});
    expect(invitations).toEqual([expect.objectContaining({ memberId: invited.memberId, role: 'viewer' })]);
    const accepted = await as(person).merchantOps.team.acceptInvite({ memberId: invited.memberId! });
    expect(accepted).toMatchObject({ userId: person, status: 'active', role: 'viewer', label: 'Jo' });
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'join@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 0,
      accepted: 0,
    });

    const other = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${other})`;
    const elsewhere = await as(other).merchantOps.team.invite({ email: 'join@example.com', role: 'viewer' });
    const second = await claimEmailTeamInvites(sql, { userId: person, email: 'join@example.com' }, LIMIT.ttlMs);
    expect(second).toEqual({ claimed: 1, accepted: 0 });
    const pending = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${elsewhere.memberId}`;
    expect(pending[0]).toMatchObject({ user_id: person, status: 'invited' });
    const otherList = await as(other).merchantOps.team.list({ limit: 20 });
    expect(JSON.stringify(otherList)).not.toContain(person);
    expect(otherList.items.find((member) => member.memberId === elsewhere.memberId)?.userId).toBe('email:join@example.com');
    expect(await refusal(() => as(person).merchantOps.team.acceptInvite({ memberId: elsewhere.memberId! }))).toBe(
      'pay.team_member_unavailable',
    );

    const own = await as(host).merchantOps.team.invite({ email: 'host@example.com', role: 'viewer' });
    const ownerClaim = await claimEmailTeamInvites(sql, { userId: host, email: 'host@example.com' }, LIMIT.ttlMs);
    expect(ownerClaim).toEqual({ claimed: 1, accepted: 0 });
    const ownerRow = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${own.memberId}`;
    expect(ownerRow[0]).toMatchObject({ user_id: host, status: 'invited' });
    const hostList = await as(host).merchantOps.team.list({ limit: 20 });
    expect(hostList.items.find((member) => member.memberId === own.memberId)?.userId).toBe('email:host@example.com');
  }, 20_000);

  it('does not revive a removed member when a later email invite is claimed', async () => {
    const host = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${host})`;
    const person = id();
    const byAccount = await as(host).merchantOps.team.invite({ userId: person, role: 'viewer' });
    await as(person).merchantOps.team.acceptInvite({ memberId: byAccount.memberId! });
    await as(host).merchantOps.team.remove({ memberId: byAccount.memberId! });
    const emailInvite = await as(host).merchantOps.team.invite({ email: 'former@example.com', role: 'developer' });
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'former@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const removed = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${byAccount.memberId}`;
    expect(removed[0]).toMatchObject({ user_id: person, status: 'removed' });
    const fresh = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${emailInvite.memberId}`;
    expect(fresh[0]).toMatchObject({ user_id: 'email:former@example.com', status: 'invited' });
    const invitations = await as(person).merchantOps.team.myInvitations({});
    expect(invitations.find((invite) => invite.memberId === emailInvite.memberId)).toBeUndefined();

    const rebound = await as(host).merchantOps.team.invite({ email: 'left@example.com', role: 'viewer', label: 'Left' });
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'left@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const still = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${rebound.memberId}`;
    expect(still[0]).toMatchObject({ user_id: 'email:left@example.com', status: 'invited' });
  }, 20_000);

  it('does not revive a declined email invite, and a new one stays pending', async () => {
    const host = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${host})`;
    const person = id();
    const invited = await as(host).merchantOps.team.invite({ email: 'declined@example.com', role: 'viewer', label: 'Left' });
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'declined@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 1,
      accepted: 0,
    });
    await as(person).merchantOps.team.declineInvite({ memberId: invited.memberId! });
    const removed = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${invited.memberId}`;
    expect(removed[0]).toMatchObject({ user_id: person, status: 'removed' });
    const removedList = await as(host).merchantOps.team.list({ limit: 20, status: 'removed' });
    expect(removedList.items.find((member) => member.memberId === invited.memberId)?.userId).toBe('email:declined@example.com');
    expect(JSON.stringify(removedList)).not.toContain(person);
    const again = await as(host).merchantOps.team.invite({ email: 'declined@example.com', role: 'finance' });
    expect(again.memberId).not.toBe(invited.memberId);
    expect(again).toMatchObject({ userId: 'email:declined@example.com', status: 'invited', role: 'finance' });
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'declined@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const stillRemoved = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${invited.memberId}`;
    expect(stillRemoved[0]).toMatchObject({ user_id: person, status: 'removed' });
    const fresh = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${again.memberId}`;
    expect(fresh[0]).toMatchObject({ user_id: 'email:declined@example.com', status: 'invited' });
    const invitations = await as(person).merchantOps.team.myInvitations({});
    expect(invitations.find((invite) => invite.memberId === again.memberId || invite.memberId === invited.memberId)).toBeUndefined();
  }, 20_000);

  it('refuses a claim that is not a real account id and does not write', async () => {
    await expect(
      claimEmailTeamInvites(sql, { userId: 'email:ada@example.com', email: 'ada@example.com' }, LIMIT.ttlMs),
    ).rejects.toBeInstanceOf(MerchantOpsError);
  });

  it('does not bind when the lifetime is unset or the invite is older than it', async () => {
    const host = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${host})`;
    const fresh = await as(host).merchantOps.team.invite({ email: 'later@example.com', role: 'viewer' });
    const person = id();
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'later@example.com' }, undefined)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const still = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${fresh.memberId}`;
    expect(still[0]).toMatchObject({ user_id: 'email:later@example.com', status: 'invited' });

    await sql`UPDATE pay.merchant_team_members SET updated_at = now() - interval '2 hours' WHERE id = ${fresh.memberId}`;
    expect(await claimEmailTeamInvites(sql, { userId: person, email: 'later@example.com' }, 60_000)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    const aged = await sql<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM pay.merchant_team_members WHERE id = ${fresh.memberId}`;
    expect(aged[0]).toMatchObject({ user_id: 'email:later@example.com', status: 'invited' });

    await as(host).merchantOps.team.invite({ email: 'later@example.com', role: 'developer' });
    const renewed = await claimEmailTeamInvites(sql, { userId: person, email: 'later@example.com' }, 60_000);
    expect(renewed).toEqual({ claimed: 1, accepted: 0 });
    const bound = await sql<Array<{ user_id: string; status: string; role: string }>>`
      SELECT user_id, status, role FROM pay.merchant_team_members WHERE id = ${fresh.memberId}`;
    expect(bound[0]).toMatchObject({ user_id: person, status: 'invited', role: 'developer' });
    const shown = await as(host).merchantOps.team.list({ limit: 20 });
    expect(shown.items.find((member) => member.memberId === fresh.memberId)?.userId).toBe('email:later@example.com');
    expect(JSON.stringify(shown)).not.toContain(person);
  }, 20_000);

  it('J-merchant-11 #1 #2: mails a link that runs out; a resend replaces it; an expired or unbound link is refused', async () => {
    const host = id();
    const hostMerchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${host}) RETURNING id`)[0]!.id;
    const caller = as(host, {}, roomy());
    const before = Date.now();
    const invited = await caller.merchantOps.team.invite({ email: ' Link@Example.com ', role: 'finance' });
    const mail = sent.filter((m) => m.memberId === invited.memberId);
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ email: 'link@example.com', role: 'finance', resent: false });
    expect(invited.expiresAt).toBe(mail[0]!.expiresAt.toISOString());
    expect(Date.parse(invited.expiresAt!) - before).toBeGreaterThanOrEqual(LIMIT.ttlMs - 1_000);
    // Only the hash is stored, never the code.
    const stored = await sql<Array<{ invite_link_hash: string }>>`
      SELECT invite_link_hash FROM pay.merchant_team_members WHERE id = ${invited.memberId}`;
    expect(stored[0]!.invite_link_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(mail[0]!.code);
    const oldCode = mail[0]!.code;

    const resent = await caller.merchantOps.team.resendInvite({ memberId: invited.memberId! });
    expect(resent.status).toBe('invited');
    const newCode = lastCode(invited.memberId!);
    expect(newCode).not.toBe(oldCode);
    expect(sent.filter((m) => m.memberId === invited.memberId).at(-1)!.resent).toBe(true);
    const trail = await caller.merchantOps.team.history({ limit: 20 });
    expect(trail.items.some((e) => e.action === 'resent' && e.memberUserId === 'email:link@example.com')).toBe(true);

    const person = id();
    // Not yet bound to the account (the invited address is unconfirmed): the newest link alone is no key.
    expect(await refusal(() => as(person).merchantOps.team.acceptInvite({ memberId: invited.memberId!, code: newCode }))).toBe(
      'pay.team_invite_email_unconfirmed',
    );
    await claimEmailTeamInvites(sql, { userId: person, email: 'link@example.com' }, LIMIT.ttlMs);
    expect(await refusal(() => as(person).merchantOps.team.acceptInvite({ memberId: invited.memberId!, code: oldCode }))).toBe(
      'pay.team_invite_link_invalid',
    );
    expect(await refusal(() => as(person).merchantOps.team.acceptInvite({ memberId: invited.memberId!, code: 'guess' }))).toBe(
      'pay.team_invite_link_invalid',
    );
    const joined = await as(person).merchantOps.team.acceptInvite({ memberId: invited.memberId!, code: newCode });
    expect(joined).toMatchObject({ status: 'active', role: 'finance', expiresAt: null });
    // Used once: the link no longer works.
    expect(await refusal(() => as(person).merchantOps.team.acceptInvite({ memberId: invited.memberId!, code: newCode }))).toBe(
      'pay.team_invite_link_invalid',
    );
    // An active member is not an invitation: nothing to resend.
    expect(await refusal(() => caller.merchantOps.team.resendInvite({ memberId: invited.memberId! }))).toBe(
      'pay.team_invite_not_resendable',
    );

    // Expired: the link and the list accept both refuse, and the row stays pending; a claim does not bind it.
    const late = await caller.merchantOps.team.invite({ email: 'late@example.com', role: 'viewer' });
    const lateCode = lastCode(late.memberId!);
    await sql`UPDATE pay.merchant_team_members SET invite_expires_at = now() - interval '1 minute' WHERE id = ${late.memberId}`;
    const latePerson = id();
    expect(await claimEmailTeamInvites(sql, { userId: latePerson, email: 'late@example.com' }, LIMIT.ttlMs)).toEqual({
      claimed: 0,
      accepted: 0,
    });
    expect(await refusal(() => as(latePerson).merchantOps.team.acceptInvite({ memberId: late.memberId!, code: lateCode }))).toBe(
      'pay.team_invitation_expired',
    );
    const lateRow = await sql<Array<{ status: string }>>`SELECT status FROM pay.merchant_team_members WHERE id = ${late.memberId}`;
    expect(lateRow[0]!.status).toBe('invited');
    // Bound before it ran out, then expired: the list accept refuses too.
    const bound = await caller.merchantOps.team.invite({ email: 'bound@example.com', role: 'viewer' });
    const boundPerson = id();
    await claimEmailTeamInvites(sql, { userId: boundPerson, email: 'bound@example.com' }, LIMIT.ttlMs);
    await sql`UPDATE pay.merchant_team_members SET invite_expires_at = now() - interval '1 minute' WHERE id = ${bound.memberId}`;
    expect(await refusal(() => as(boundPerson).merchantOps.team.acceptInvite({ memberId: bound.memberId! }))).toBe(
      'pay.team_invitation_expired',
    );

    // A mail that cannot be written leaves nothing stored.
    const broken: TeamInviteMail = { send: async () => Promise.reject(new Error('disk full')) };
    await expect(
      as(host, {}, { ...roomy(), teamInviteMail: broken }).merchantOps.team.invite({ email: 'lost@example.com', role: 'viewer' }),
    ).rejects.toThrow();
    const lost =
      await sql`SELECT 1 FROM pay.merchant_team_members WHERE merchant_id = ${hostMerchant} AND user_id = 'email:lost@example.com'`;
    expect(lost).toHaveLength(0);
  }, 20_000);

  it('counts a re-invite and a resend against the window: each one sends a mail', async () => {
    const tight = id();
    await sql`INSERT INTO pay.merchants (user_id) VALUES (${tight})`;
    const caller = as(tight);
    const first = await caller.merchantOps.team.invite({ email: 'again@example.com', role: 'viewer' });
    await caller.merchantOps.team.resendInvite({ memberId: first.memberId! });
    expect(await refusal(() => caller.merchantOps.team.resendInvite({ memberId: first.memberId! }))).toBe(
      'pay.team_email_invite_rate_limited',
    );
    expect(await refusal(() => caller.merchantOps.team.invite({ email: 'again@example.com', role: 'viewer' }))).toBe(
      'pay.team_email_invite_rate_limited',
    );
  });
});
