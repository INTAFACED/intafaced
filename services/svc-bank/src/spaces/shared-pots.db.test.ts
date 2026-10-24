/**
 * BK-acct-09 (J-bank-07 #6): shared pots, through the router. The owner invites a contributor by handle and a viewer by
 * email; an invite past its owner-set lifetime refuses `bank.invite_expired`; a pot shared with the owner-set number of
 * people refuses another invite; the contributor adds money with the same transfer as anyone, while the viewer adding
 * money, and any member taking money out, refuses `bank.space_forbidden` and moves nothing. The log names who did what.
 *
 * Postgres (TEST_DATABASE_URL) and a MemoryLedger.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, subAccountAvailable, userAvailable } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState, type BankServices } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { memoryBusinessDirectory, type DirectoryPerson } from '../business/business-directory.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';

const db: TestDatabase = await createTestDatabase({ service: 'bank', url: DB_URL, migrations: MIGRATIONS });
const sql = db.sql;

afterAll(async () => {
  await db.drop();
}, 30_000);

const SECRET = 'c'.repeat(32);
const SID = '77777777-7777-4777-8777-777777777777';
const OWNER = '61111111-1111-4111-8111-111111111111';
const PARTNER = '62222222-2222-4222-8222-222222222222';
const VIEWER = '63333333-3333-4333-8333-333333333333';
const THIRD = '64444444-4444-4444-8444-444444444444';
const FROZEN = '65555555-5555-4555-8555-555555555555';

const PEOPLE: DirectoryPerson[] = [
  { userId: OWNER, handle: 'Olga_Owner', email: 'olga@example.com', status: 'active' },
  { userId: PARTNER, handle: 'Pia_Partner', email: 'pia@example.com', status: 'active' },
  { userId: VIEWER, handle: 'Vic_Viewer', email: 'vic@example.com', status: 'active' },
  { userId: THIRD, handle: 'Tom_Third', email: 'tom@example.com', status: 'active' },
  { userId: FROZEN, handle: 'Fro_Zen', email: 'fro@example.com', status: 'frozen' },
];

let ledger: MemoryLedger;

beforeEach(async () => {
  await sql`TRUNCATE bank.shared_pot_activity, bank.shared_pot_members, bank.shared_pot_invites, bank.spaces RESTART IDENTITY CASCADE`;
  ledger = new MemoryLedger();
});

function services(terms: { minutes?: string; cap?: string } = { minutes: '60', cap: '2' }) {
  return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
    recipients: memoryRecipientState(),
    directory: memoryBusinessDirectory(PEOPLE),
    sharedPotInviteMinutes: terms.minutes,
    sharedPotPeopleCap: terms.cap,
  });
}

function caller(bank: BankServices, userId: string) {
  const raw = encodePrincipal({
    sub: userId,
    userId,
    sid: SID,
    scopes: ['bank:read', 'bank:write'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal);
  const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
  return createBankRouter(bank, {}).createCaller(
    edge({
      headers: {
        'x-intafaced-principal': raw,
        'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
        'x-intafaced-region': 'DE',
      },
      id: `req-${randomUUID()}`,
    }),
  );
}

const refused = (code: string, trpc: string) => ({ code: trpc, cause: expect.objectContaining({ code }) });

async function fund(userId: string, amount: string) {
  await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt(amount), rail: 'test', railRef: randomUUID() }));
}
const main = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
const inPot = async (spaceId: string) => formatAmount((await ledger.balance(subAccountAvailable(spaceId, 'USDT'))).amount);

/** The owner's pot holding 10, the partner and the viewer each with 20 in their own account. */
async function sharedPot(bank: BankServices) {
  await fund(OWNER, '10');
  await bank.spaces.ensurePrimary(OWNER, 'USDT');
  const pot = await bank.spaces.create({ userId: OWNER, assetId: 'USDT', name: 'Holiday TEST' });
  const ownerMain = (await bank.spaces.findPrimary(OWNER, 'USDT'))!;
  await caller(bank, OWNER).transfers.create({
    transferId: `own-${randomUUID()}`,
    fromSpaceId: ownerMain.id,
    toSpaceId: pot.id,
    amount: '10',
  });
  for (const who of [PARTNER, VIEWER]) {
    await fund(who, '20');
    await bank.spaces.ensurePrimary(who, 'USDT');
  }
  return pot;
}

describe('sharedPots', () => {
  it('a contributor adds money with an ordinary transfer; a viewer adding, or any member taking out, refuses by name and moves nothing', async () => {
    const bank = services();
    const pot = await sharedPot(bank);
    const owner = caller(bank, OWNER);
    const asPartner = await owner.sharedPots.invite({
      inviteId: randomUUID(),
      spaceId: pot.id,
      handle: '@pia_partner',
      role: 'contributor',
    });
    expect(asPartner.invitee).toEqual({ userId: PARTNER, handle: 'Pia_Partner' });
    const asViewer = await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, email: 'vic@example.com', role: 'viewer' });
    expect(Date.parse(asViewer.expiresAt) - Date.parse(asViewer.createdAt)).toBe(60 * 60_000);

    const partner = caller(bank, PARTNER);
    const viewer = caller(bank, VIEWER);
    const mine = await partner.sharedPots.list({ limit: 50 });
    expect(mine.invites.map((i) => [i.pot.name, i.owner.handle, i.role, i.expired])).toEqual([
      ['Holiday TEST', 'Olga_Owner', 'contributor', false],
    ]);
    expect(await partner.sharedPots.accept({ inviteId: asPartner.inviteId })).toEqual({ spaceId: pot.id, role: 'contributor' });
    // Accepting again returns the same membership.
    expect(await partner.sharedPots.accept({ inviteId: asPartner.inviteId })).toEqual({ spaceId: pot.id, role: 'contributor' });
    await viewer.sharedPots.accept({ inviteId: asViewer.inviteId });

    const seen = await viewer.sharedPots.list({ limit: 50 });
    expect(seen.shared.map((s) => [s.pot.name, s.pot.balance, s.owner.handle, s.role])).toEqual([
      ['Holiday TEST', '10', 'Olga_Owner', 'viewer'],
    ]);
    expect(seen.shared[0]!.members.map((m) => [m.handle, m.role])).toEqual([
      ['Pia_Partner', 'contributor'],
      ['Vic_Viewer', 'viewer'],
    ]);

    const partnerMain = (await bank.spaces.findPrimary(PARTNER, 'USDT'))!;
    await partner.transfers.create({ transferId: `add-${randomUUID()}`, fromSpaceId: partnerMain.id, toSpaceId: pot.id, amount: '5' });
    expect(await inPot(pot.id)).toBe('15');
    expect(await main(PARTNER)).toBe('15');

    const viewerMain = (await bank.spaces.findPrimary(VIEWER, 'USDT'))!;
    await expect(
      viewer.transfers.create({ transferId: `add-${randomUUID()}`, fromSpaceId: viewerMain.id, toSpaceId: pot.id, amount: '5' }),
    ).rejects.toMatchObject(refused('bank.space_forbidden', 'FORBIDDEN'));
    for (const member of [viewer, partner]) {
      const to = member === viewer ? viewerMain : partnerMain;
      await expect(
        member.transfers.create({ transferId: `take-${randomUUID()}`, fromSpaceId: pot.id, toSpaceId: to.id, amount: '1' }),
      ).rejects.toMatchObject(refused('bank.space_forbidden', 'FORBIDDEN'));
    }
    // Someone with no share in the pot gets the ordinary ownership refusal, which names nothing.
    await fund(THIRD, '1');
    const thirdMain = await bank.spaces.ensurePrimary(THIRD, 'USDT');
    const stranger = caller(bank, THIRD).transfers.create({
      transferId: `take-${randomUUID()}`,
      fromSpaceId: pot.id,
      toSpaceId: thirdMain.id,
      amount: '1',
    });
    await expect(stranger).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'This account belongs to another user' });
    expect([await inPot(pot.id), await main(VIEWER), await main(PARTNER)]).toEqual(['15', '20', '15']);
  });

  it('an invite past its lifetime refuses bank.invite_expired and nobody joins', async () => {
    const bank = services();
    const pot = await sharedPot(bank);
    const made = await caller(bank, OWNER).sharedPots.invite({
      inviteId: randomUUID(),
      spaceId: pot.id,
      handle: 'Vic_Viewer',
      role: 'viewer',
    });
    await sql`UPDATE bank.shared_pot_invites SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' WHERE id = ${made.inviteId}`;
    const viewer = caller(bank, VIEWER);
    expect((await viewer.sharedPots.list({ limit: 50 })).invites.map((i) => i.expired)).toEqual([true]);
    await expect(viewer.sharedPots.accept({ inviteId: made.inviteId })).rejects.toMatchObject(refused('bank.invite_expired', 'CONFLICT'));
    expect((await viewer.sharedPots.list({ limit: 50 })).shared).toEqual([]);
    // An expired invite no longer holds a place, and the owner can ask again.
    const again = await caller(bank, OWNER).sharedPots.invite({
      inviteId: randomUUID(),
      spaceId: pot.id,
      handle: 'Vic_Viewer',
      role: 'viewer',
    });
    expect((await viewer.sharedPots.accept({ inviteId: again.inviteId })).role).toBe('viewer');
  });

  it('a pot shared with the cap, open invites included, refuses another invite', async () => {
    const bank = services();
    const pot = await sharedPot(bank);
    const owner = caller(bank, OWNER);
    const first = await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Pia_Partner', role: 'contributor' });
    await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Vic_Viewer', role: 'viewer' });
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Tom_Third', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.shared_pot_full', 'CONFLICT'));
    await caller(bank, PARTNER).sharedPots.accept({ inviteId: first.inviteId });
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Tom_Third', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.shared_pot_full', 'CONFLICT'));
    // A member who leaves frees the place.
    await caller(bank, PARTNER).sharedPots.leave({ spaceId: pot.id });
    await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Tom_Third', role: 'viewer' });
  });

  it('the same invite id returns the same invite; a different invite under it, yourself, a member, a frozen or unknown person refuse', async () => {
    const bank = services();
    const pot = await sharedPot(bank);
    const owner = caller(bank, OWNER);
    const inviteId = randomUUID();
    const made = await owner.sharedPots.invite({ inviteId, spaceId: pot.id, handle: 'Pia_Partner', role: 'contributor' });
    expect(await owner.sharedPots.invite({ inviteId, spaceId: pot.id, handle: 'Pia_Partner', role: 'contributor' })).toEqual(made);
    await expect(owner.sharedPots.invite({ inviteId, spaceId: pot.id, handle: 'Pia_Partner', role: 'viewer' })).rejects.toMatchObject(
      refused('bank.shared_pot_invalid', 'BAD_REQUEST'),
    );
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Pia_Partner', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.shared_pot_invalid', 'BAD_REQUEST'));
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Olga_Owner', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.shared_pot_invalid', 'BAD_REQUEST'));
    for (const handle of ['Fro_Zen', 'nobody_here']) {
      await expect(owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle, role: 'viewer' })).rejects.toMatchObject(
        refused('bank.invitee_not_found', 'NOT_FOUND'),
      );
    }
    // Only the owner's own live named pot can be shared.
    const main = (await bank.spaces.findPrimary(OWNER, 'USDT'))!;
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: main.id, handle: 'Tom_Third', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.space_change_invalid', 'BAD_REQUEST'));
    await expect(
      caller(bank, PARTNER).sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Tom_Third', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.space_not_found', 'NOT_FOUND'));
    await caller(bank, PARTNER).sharedPots.accept({ inviteId });
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Pia_Partner', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.shared_pot_invalid', 'BAD_REQUEST'));
  });

  it('the log names who invited, joined, declined, left and was removed, newest first, for the owner and members only', async () => {
    const bank = services({ minutes: '60', cap: '3' });
    const pot = await sharedPot(bank);
    const owner = caller(bank, OWNER);
    const a = await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Pia_Partner', role: 'contributor' });
    const b = await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Vic_Viewer', role: 'viewer' });
    const c = await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Tom_Third', role: 'viewer' });
    await caller(bank, PARTNER).sharedPots.accept({ inviteId: a.inviteId });
    await caller(bank, VIEWER).sharedPots.accept({ inviteId: b.inviteId });
    await caller(bank, THIRD).sharedPots.decline({ inviteId: c.inviteId });
    await expect(caller(bank, THIRD).sharedPots.accept({ inviteId: c.inviteId })).rejects.toMatchObject(
      refused('bank.invite_not_found', 'NOT_FOUND'),
    );
    await caller(bank, VIEWER).sharedPots.leave({ spaceId: pot.id });
    await owner.sharedPots.remove({ spaceId: pot.id, userId: PARTNER });

    const log = await owner.sharedPots.activity({ spaceId: pot.id, limit: 50 });
    expect(log.map((e) => [e.kind, e.actor.handle, e.subject?.handle ?? null, e.role])).toEqual([
      ['removed', 'Olga_Owner', 'Pia_Partner', 'contributor'],
      ['left', 'Vic_Viewer', null, 'viewer'],
      ['declined', 'Tom_Third', null, 'viewer'],
      ['joined', 'Vic_Viewer', null, 'viewer'],
      ['joined', 'Pia_Partner', null, 'contributor'],
      ['invited', 'Olga_Owner', 'Tom_Third', 'viewer'],
      ['invited', 'Olga_Owner', 'Vic_Viewer', 'viewer'],
      ['invited', 'Olga_Owner', 'Pia_Partner', 'contributor'],
    ]);
    const older = await owner.sharedPots.activity({ spaceId: pot.id, limit: 2, before: log[5]!.id });
    expect(older.map((e) => e.subject?.handle)).toEqual(['Vic_Viewer', 'Pia_Partner']);
    // Gone from the pot, gone from its log.
    await expect(caller(bank, PARTNER).sharedPots.activity({ spaceId: pot.id, limit: 50 })).rejects.toMatchObject(
      refused('bank.space_not_found', 'NOT_FOUND'),
    );
    expect((await owner.sharedPots.list({ limit: 50 })).owned).toEqual([]);
  });

  it('blank owner values refuse bank.joint_unset and the list says they are not set; a blank page size refuses', async () => {
    const bank = services({});
    const pot = await sharedPot(bank);
    const owner = caller(bank, OWNER);
    await expect(
      owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: pot.id, handle: 'Pia_Partner', role: 'viewer' }),
    ).rejects.toMatchObject(refused('bank.joint_unset', 'PRECONDITION_FAILED'));
    expect((await owner.sharedPots.list({ limit: 50 })).terms).toEqual({ inviteMinutes: null, peopleCap: null });
    await expect(owner.sharedPots.list({})).rejects.toMatchObject(refused('bank.shared_pots_list_limit_unset', 'BAD_REQUEST'));
    await expect(owner.sharedPots.activity({ spaceId: pot.id })).rejects.toMatchObject(
      refused('bank.shared_pots_list_limit_unset', 'BAD_REQUEST'),
    );
    expect(await sql`SELECT 1 FROM bank.shared_pot_invites`).toHaveLength(0);
  });
});
