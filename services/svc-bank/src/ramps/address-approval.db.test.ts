import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceMailRequest } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { BankError } from '../errors.js';
import { memorySecurityLock } from '../security-lock.js';
import { memoryWithdrawDestinations, UserWithdrawDestinationStore, type UserWithdrawDestinations } from '../withdraw-destination.js';
import {
  approveByLink,
  approveOnDevice,
  createIdentityApprovalMail,
  deviceComparison,
  memoryApprovalLinks,
  openApprovalLinks,
  requestApprovalMail,
  requireApprovalLinkMinutes,
  sqlApprovalLinks,
  type AddressApprovalDeps,
  type ApprovalLinkStore,
  type ApprovalMailPort,
} from './address-approval.js';

/**
 * W-withdraw-09 new-address approval (J-wallet-04 #5) on both stores: the in-memory ones tests use and
 * `bank.user_withdraw_destinations` with `bank.destination_approval_links` (migration 20261024100000), so a test double
 * can never be more forgiving than the real tables.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function dedicatedTestUrl(raw: string): string {
  const parsed = new URL(raw);
  if (!parsed.pathname.replace(/^\//, '').endsWith('_test')) parsed.pathname = '/intafaced_test';
  return parsed.toString();
}

if (!process.env.TEST_DATABASE_URL?.trim()) {
  throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
}

const ADDRESS = '0x1111111111111111111111111111111111111111';
const MAIL_ID = '55555555-5555-4555-8555-555555555555';

let db!: TestDatabase;
let users = 0;

beforeAll(async () => {
  db = await createTestDatabase({ service: 'bank', url: dedicatedTestUrl(process.env.TEST_DATABASE_URL!.trim()), migrations });
}, 120_000);
afterAll(() => db?.drop());

const fresh = () => `00000000-0000-4000-8000-${String(++users).padStart(12, '0')}`;

/** Identity's mail door as a recorder: every request it was asked, and what it answers. */
function mailbox(): ApprovalMailPort & { sent: ServiceMailRequest[]; refuse: BankError | null } {
  const box = {
    sent: [] as ServiceMailRequest[],
    refuse: null as BankError | null,
    async send(request: ServiceMailRequest) {
      if (box.refuse) throw box.refuse;
      box.sent.push(request);
      return { mailId: MAIL_ID };
    },
  };
  return box;
}

const stores: Array<[string, () => { destinations: UserWithdrawDestinations; links: ApprovalLinkStore }]> = [
  ['memory stores', () => ({ destinations: memoryWithdrawDestinations({ addressBookCap: () => '5' }), links: memoryApprovalLinks() })],
  [
    'postgres stores',
    () => ({ destinations: new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => '5' }), links: sqlApprovalLinks(db.sql) }),
  ],
];

describe.each(stores)('new-address approval: %s', (_name, make) => {
  function setup(minutes = '30') {
    const { destinations, links } = make();
    const mail = mailbox();
    const lock = memorySecurityLock();
    const clock = { now: new Date() };
    const deps: AddressApprovalDeps = {
      destinations,
      links,
      mail,
      securityLock: lock,
      linkMinutesRaw: () => minutes,
      now: () => clock.now,
    };
    return { deps, destinations, links, mail, lock, clock };
  }
  async function saved(destinations: UserWithdrawDestinations, userId: string) {
    return destinations.save({ userId, assetId: 'USDT', network: 'erc20', ref: ADDRESS, label: 'Cold wallet' });
  }

  it('mails a single-use link under a numbered business key, with what the address is and until when the link works', async () => {
    const { deps, destinations, mail, clock } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    const asked = await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    const expiresAt = new Date(Math.floor(clock.now.getTime() / 1000) * 1000 + 30 * 60_000).toISOString();
    expect(asked).toEqual({ destinationId: entry.destinationId, expiresAt });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({
      key: `address-approval:${entry.destinationId}:1`,
      userId: u,
      purpose: 'withdraw-address-approval',
      detail: 'USDT on erc20, 0x1111...1111',
      expiresAt,
    });
    expect(mail.sent[0]!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The book says a link is out, and until when.
    expect((await openApprovalLinks(deps, u)).get(entry.destinationId)).toBe(expiresAt);
    // Asking again is the next link, with its own key and token.
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    expect(mail.sent[1]!.key).toBe(`address-approval:${entry.destinationId}:2`);
    expect(mail.sent[1]!.token).not.toBe(mail.sent[0]!.token);
  });

  it('refuses a link with no owner lifetime, while locked, and for an entry approved already, mailing nothing', async () => {
    const u = fresh();
    const unset = setup('');
    const entry = await saved(unset.destinations, u);
    await expect(requestApprovalMail(unset.deps, { userId: u, destinationId: entry.destinationId })).rejects.toMatchObject({
      code: 'bank.address_approval_link_unset',
    });
    // More than seven days is more than identity shows a link for.
    expect(() => requireApprovalLinkMinutes('10081')).toThrow(expect.objectContaining({ code: 'bank.address_approval_link_unset' }));
    expect(requireApprovalLinkMinutes('10080')).toBe(10080);

    const { deps, destinations, mail, lock } = setup();
    const v = fresh();
    const other = await saved(destinations, v);
    lock.set(v, { locked: true, unlocksAt: null });
    await expect(requestApprovalMail(deps, { userId: v, destinationId: other.destinationId })).rejects.toMatchObject({
      code: 'bank.security_locked',
    });
    lock.set(v, { locked: false, unlocksAt: null });
    await destinations.approve({ userId: v, destinationId: other.destinationId, by: 'link' });
    await expect(requestApprovalMail(deps, { userId: v, destinationId: other.destinationId })).rejects.toMatchObject({
      code: 'bank.address_approval_not_pending',
    });
    expect(mail.sent).toEqual([]);
  });

  it('approves by the newest link for the customer it was sent to: the cooling-off starts then, and opening it again changes nothing', async () => {
    const { deps, destinations, mail } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    const token = mail.sent[0]!.token;
    // Someone else signed in, or a made-up token, is not told whose link it is.
    await expect(approveByLink(deps, { userId: fresh(), token })).rejects.toMatchObject({ code: 'bank.address_approval_link_invalid' });
    await expect(approveByLink(deps, { userId: u, token: 'not-a-token' })).rejects.toMatchObject({
      code: 'bank.address_approval_link_invalid',
    });
    await expect(
      approveByLink(deps, { userId: u, token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` }),
    ).rejects.toMatchObject({
      code: 'bank.address_approval_link_invalid',
    });
    const approved = await approveByLink(deps, { userId: u, token });
    expect(approved).toMatchObject({ destinationId: entry.destinationId, state: 'cooling', approvedBy: 'link' });
    expect(await openApprovalLinks(deps, u)).toEqual(new Map());
    const again = await approveByLink(deps, { userId: u, token });
    expect(again).toMatchObject({ state: 'cooling', approvedBy: 'link' });
    expect(again.updatedAt).toEqual(approved.updatedAt);
  });

  it('a replaced or expired link approves nothing and says which; a new link then works', async () => {
    const { deps, destinations, mail, clock } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    const [first, second] = mail.sent.map((m) => m.token);
    await expect(approveByLink(deps, { userId: u, token: first! })).rejects.toMatchObject({ code: 'bank.address_approval_link_replaced' });
    clock.now = new Date(clock.now.getTime() + 31 * 60_000);
    await expect(approveByLink(deps, { userId: u, token: second! })).rejects.toMatchObject({ code: 'bank.address_approval_link_expired' });
    expect(await openApprovalLinks(deps, u)).toEqual(new Map());
    expect((await destinations.list(u))[0]!.state).toBe('pending');
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    await expect(approveByLink(deps, { userId: u, token: mail.sent[2]!.token })).resolves.toMatchObject({ state: 'cooling' });
  });

  it('a link whose mail identity refused was never sent, so it never works and the one before it still does', async () => {
    const { deps, destinations, mail } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    mail.refuse = new BankError('no mail service', 'bank.address_approval_mail_unavailable');
    await expect(requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId })).rejects.toMatchObject({
      code: 'bank.address_approval_mail_unavailable',
    });
    await expect(approveByLink(deps, { userId: u, token: mail.sent[0]!.token })).resolves.toMatchObject({ state: 'cooling' });
  });

  it('refuses to approve by link while the security lock holds, and the link still works once it ends', async () => {
    const { deps, destinations, mail, lock } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    lock.set(u, { locked: true, unlocksAt: null });
    await expect(approveByLink(deps, { userId: u, token: mail.sent[0]!.token })).rejects.toMatchObject({ code: 'bank.security_locked' });
    lock.set(u, { locked: false, unlocksAt: null });
    await expect(approveByLink(deps, { userId: u, token: mail.sent[0]!.token })).resolves.toMatchObject({ state: 'cooling' });
  });

  it('two openings of one link at once both answer the approved entry, approved once', async () => {
    const { deps, destinations, mail } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    const token = mail.sent[0]!.token;
    const [a, b] = await Promise.all([approveByLink(deps, { userId: u, token }), approveByLink(deps, { userId: u, token })]);
    expect(a).toMatchObject({ state: 'cooling', approvedBy: 'link' });
    expect(b).toMatchObject({ state: 'cooling', approvedBy: 'link' });
    expect(b.updatedAt).toEqual(a.updatedAt);
  });

  it('an older or expired link for an address approved already answers it as approved, and changes nothing', async () => {
    const { deps, destinations, mail, clock } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    const approved = await approveByLink(deps, { userId: u, token: mail.sent[1]!.token });
    clock.now = new Date(clock.now.getTime() + 31 * 60_000);
    for (const token of [mail.sent[0]!.token, mail.sent[1]!.token]) {
      const again = await approveByLink(deps, { userId: u, token });
      expect(again).toMatchObject({ state: 'cooling', approvedBy: 'link' });
      expect(again.updatedAt).toEqual(approved.updatedAt);
    }
  });

  it('a link the bank failed to record as mailed still works: its token only exists in the mail identity took', async () => {
    const { deps, destinations, links, mail } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    const failing: ApprovalLinkStore = {
      ...links,
      async markMailed() {
        throw new Error('database blip');
      },
    };
    await expect(requestApprovalMail({ ...deps, links: failing }, { userId: u, destinationId: entry.destinationId })).rejects.toThrow(
      'database blip',
    );
    expect(mail.sent).toHaveLength(1);
    await expect(approveByLink(deps, { userId: u, token: mail.sent[0]!.token })).resolves.toMatchObject({ state: 'cooling' });
  });

  it('a link to an address removed since approves nothing', async () => {
    const { deps, destinations, mail } = setup();
    const u = fresh();
    const entry = await saved(destinations, u);
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    await destinations.remove({ userId: u, destinationId: entry.destinationId, idempotencyKey: `remove:${entry.destinationId}` });
    await expect(approveByLink(deps, { userId: u, token: mail.sent[0]!.token })).rejects.toMatchObject({
      code: 'bank.withdraw_destination_missing',
    });
  });

  describe('from another signed-in device', () => {
    const SIGN_IN_A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const SIGN_IN_B = 'bbbbbbbb-0000-4000-8000-000000000002';
    const DEVICE_A = 'aaaaaaaa-1111-4111-8111-000000000001';
    const DEVICE_B = 'bbbbbbbb-1111-4111-8111-000000000002';
    const savedFrom = (destinations: UserWithdrawDestinations, userId: string, fam: string | null, dev: string | null) =>
      destinations.save({
        userId,
        assetId: 'USDT',
        network: 'erc20',
        ref: ADDRESS,
        label: 'Cold wallet',
        savedOn: { fam, dev },
      });

    it('approves from a different sign-in: the cooling-off starts then, by device, and again changes nothing', async () => {
      const { deps, destinations, clock } = setup();
      const u = fresh();
      const entry = await savedFrom(destinations, u, SIGN_IN_A, null);
      await expect(destinations.savedOn({ userId: u, destinationId: entry.destinationId })).resolves.toEqual({ fam: SIGN_IN_A, dev: null });
      const approved = await approveOnDevice(deps, {
        userId: u,
        destinationId: entry.destinationId,
        approving: { fam: SIGN_IN_B, dev: null },
      });
      expect(approved).toMatchObject({ state: 'cooling', approvedBy: 'device' });
      expect(approved.approvedAt).toBeInstanceOf(Date);
      expect(approved.updatedAt.getTime()).toBeGreaterThanOrEqual(entry.updatedAt.getTime());
      clock.now = new Date(clock.now.getTime() + 60_000);
      const again = await approveOnDevice(deps, {
        userId: u,
        destinationId: entry.destinationId,
        approving: { fam: SIGN_IN_B, dev: null },
      });
      expect(again).toEqual(approved);
    });

    it('refuses the device that saved it, even after a refresh or a new sign-in there, and changes nothing', async () => {
      const { deps, destinations } = setup();
      const u = fresh();
      const entry = await savedFrom(destinations, u, SIGN_IN_A, DEVICE_A);
      // The same sign-in (a refreshed token keeps `fam`).
      await expect(
        approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving: { fam: SIGN_IN_A, dev: DEVICE_A } }),
      ).rejects.toMatchObject({ code: 'bank.address_approval_same_device' });
      // A new sign-in on the same trusted device is still that device.
      await expect(
        approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving: { fam: SIGN_IN_B, dev: DEVICE_A } }),
      ).rejects.toMatchObject({ code: 'bank.address_approval_same_device' });
      // With no device on the approving side, the sign-in decides: the same one refuses.
      await expect(
        approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving: { fam: SIGN_IN_A, dev: null } }),
      ).rejects.toMatchObject({ code: 'bank.address_approval_same_device' });
      const [still] = await destinations.list(u);
      expect(still).toMatchObject({ state: 'pending', approvedAt: null, approvedBy: null });
      // Another trusted device approves.
      await expect(
        approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving: { fam: SIGN_IN_B, dev: DEVICE_B } }),
      ).resolves.toMatchObject({ state: 'cooling', approvedBy: 'device' });
    });

    it('refuses when either side names no sign-in: unknown is never a different device, and the emailed link still works', async () => {
      const { deps, destinations, mail } = setup();
      const u = fresh();
      // Saved from a token that named neither (an older token, or an entry saved before this).
      const entry = await savedFrom(destinations, u, null, null);
      await expect(
        approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving: { fam: SIGN_IN_B, dev: DEVICE_B } }),
      ).rejects.toMatchObject({ code: 'bank.address_approval_device_unknown' });
      const v = fresh();
      const other = await savedFrom(destinations, v, SIGN_IN_A, null);
      await expect(
        approveOnDevice(deps, { userId: v, destinationId: other.destinationId, approving: { fam: null, dev: null } }),
      ).rejects.toMatchObject({ code: 'bank.address_approval_device_unknown' });
      await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
      await expect(approveByLink(deps, { userId: u, token: mail.sent[0]!.token })).resolves.toMatchObject({
        state: 'cooling',
        approvedBy: 'link',
      });
    });

    it("refuses while the security lock holds, another customer's entry, and a removed or missing one", async () => {
      const { deps, destinations, lock } = setup();
      const u = fresh();
      const entry = await savedFrom(destinations, u, SIGN_IN_A, null);
      const approving = { fam: SIGN_IN_B, dev: null };
      lock.set(u, { locked: true, unlocksAt: null });
      await expect(approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving })).rejects.toMatchObject({
        code: 'bank.security_locked',
      });
      lock.set(u, { locked: false, unlocksAt: null });
      const stranger = fresh();
      await expect(approveOnDevice(deps, { userId: stranger, destinationId: entry.destinationId, approving })).rejects.toMatchObject({
        code: 'bank.withdraw_destination_missing',
      });
      await expect(destinations.savedOn({ userId: stranger, destinationId: entry.destinationId })).resolves.toBeNull();
      await destinations.remove({ userId: u, destinationId: entry.destinationId, idempotencyKey: `remove:${entry.destinationId}` });
      await expect(approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving })).rejects.toMatchObject({
        code: 'bank.withdraw_destination_missing',
      });
    });

    it('an entry approved by link answers as it is; the saving ids must be uuids', async () => {
      const { deps, destinations, mail } = setup();
      const u = fresh();
      const entry = await savedFrom(destinations, u, SIGN_IN_A, null);
      await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
      const byLink = await approveByLink(deps, { userId: u, token: mail.sent[0]!.token });
      // Even the saving device gets the approved entry back: there is nothing left to approve.
      await expect(
        approveOnDevice(deps, { userId: u, destinationId: entry.destinationId, approving: { fam: SIGN_IN_A, dev: null } }),
      ).resolves.toEqual(byLink);
      await expect(savedFrom(destinations, fresh(), 'not-a-uuid', null)).rejects.toMatchObject({ code: 'bank.ramp_invalid_destination' });
    });
  });
});

describe('telling a different device', () => {
  const [F1, F2, D1, D2] = [
    '11111111-0000-4000-8000-000000000001',
    '22222222-0000-4000-8000-000000000002',
    '33333333-0000-4000-8000-000000000003',
    '44444444-0000-4000-8000-000000000004',
  ];
  it.each([
    ['both devices named and different', { fam: F1, dev: D1 }, { fam: F1, dev: D2 }, 'different'],
    ['both devices named and the same, new sign-in', { fam: F1, dev: D1 }, { fam: F2, dev: D1 }, 'same'],
    ['one device missing, different sign-ins', { fam: F1, dev: D1 }, { fam: F2, dev: null }, 'different'],
    ['one device missing, the same sign-in', { fam: F1, dev: null }, { fam: F1, dev: D2 }, 'same'],
    ['no sign-in on the saving side', { fam: null, dev: D1 }, { fam: F2, dev: null }, 'unknown'],
    ['no sign-in on the approving side', { fam: F1, dev: null }, { fam: null, dev: null }, 'unknown'],
    ['nothing named on either side', { fam: null, dev: null }, { fam: null, dev: null }, 'unknown'],
    ['different devices, but the approving token names no sign-in', { fam: F1, dev: D1 }, { fam: null, dev: D2 }, 'unknown'],
    ['case does not make a different device', { fam: F1, dev: D1 }, { fam: F2, dev: D1.toUpperCase() }, 'same'],
  ] as const)('%s', (_name, saved, approving, expected) => {
    expect(deviceComparison(saved, approving)).toBe(expected);
  });
});

describe('postgres: the approval links table', () => {
  it('keeps only the sha256 of a token, never the token', async () => {
    const destinations = new UserWithdrawDestinationStore(db.sql, { addressBookCap: () => '5' });
    const links = sqlApprovalLinks(db.sql);
    const mail = mailbox();
    const u = fresh();
    const entry = await destinations.save({ userId: u, assetId: 'USDT', network: 'erc20', ref: ADDRESS, label: 'Hash test' });
    const deps: AddressApprovalDeps = { destinations, links, mail, securityLock: memorySecurityLock(), linkMinutesRaw: () => '30' };
    await requestApprovalMail(deps, { userId: u, destinationId: entry.destinationId });
    const token = mail.sent[0]!.token;
    const rows = await db.sql<Array<Record<string, unknown>>>`SELECT * FROM bank.destination_approval_links WHERE user_id = ${u}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(rows[0])).not.toContain(token);
    expect(rows[0]!.mail_id).toBe(MAIL_ID);
  });
});

describe("identity's mail door", () => {
  const request: ServiceMailRequest = {
    key: 'address-approval:66666666-6666-4666-8666-666666666666:1',
    userId: '77777777-7777-4777-8777-777777777777',
    purpose: 'withdraw-address-approval',
    token: 'A'.repeat(43),
    detail: 'USDT on erc20, 0x1111...1111',
    expiresAt: '2026-10-24T12:00:00.000Z',
  };
  function answering(status: number, body: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchFn };
  }

  it('posts the request signed as svc-bank and returns the mail id', async () => {
    const { calls, fetchFn } = answering(200, { accepted: true, mailId: MAIL_ID });
    await expect(
      createIdentityApprovalMail('http://identity.test/', 'a-bank-approval-mail-test-secret-long-enough', fetchFn).send(request),
    ).resolves.toEqual({ mailId: MAIL_ID });
    expect(calls[0]!.url).toBe('http://identity.test/internal/mail');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(request);
    expect(Object.keys(calls[0]!.init.headers as Record<string, string>).join(' ')).toMatch(/x-intafaced/i);
  });

  it.each([
    ['no mail service', 503, { code: 'identity.mail_unwired' }, 'bank.address_approval_mail_unavailable'],
    ['no proved email', 409, { code: 'identity.email_unproved' }, 'bank.address_approval_email_unproved'],
    ['an inactive account', 409, { code: 'identity.account_not_active' }, 'bank.address_approval_email_unproved'],
    ['a key conflict', 409, { code: 'identity.mail_key_conflict' }, 'bank.address_approval_mail_unavailable'],
    ['a server error', 500, 'oops', 'bank.address_approval_mail_unavailable'],
    ['an answer with no mail id', 200, { accepted: true }, 'bank.address_approval_mail_unavailable'],
  ])('maps %s to a refusal the customer can be told', async (_case, status, body, code) => {
    const { fetchFn } = answering(status, body);
    await expect(
      createIdentityApprovalMail('http://identity.test', 'a-bank-approval-mail-test-secret-long-enough', fetchFn).send(request),
    ).rejects.toMatchObject({ code });
  });

  it('is unavailable when identity does not answer', async () => {
    const fetchFn = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(
      createIdentityApprovalMail('http://identity.test', 'a-bank-approval-mail-test-secret-long-enough', fetchFn).send(request),
    ).rejects.toMatchObject({
      code: 'bank.address_approval_mail_unavailable',
    });
  });
});
