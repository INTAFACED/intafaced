import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  SERVICE_MAIL_PATH,
  serviceCallSigner,
  serviceMailAcceptedSchema,
  type ServiceAuthMode,
  type ServiceMailRequest,
  type ServiceSigner,
} from '@intafaced/contracts';
import { transaction } from '@intafaced/db';
import { BankError, type BankErrorCode } from '../errors.js';
import { assertSecurityLockOpen, type SecurityLockPort } from '../security-lock.js';
import type { SavedOn, UserWithdrawDestinations, WithdrawDestination } from '../withdraw-destination.js';
import { deviceMayApprove, type TrustedDevicePort } from './trusted-devices.js';

/**
 * NEW-ADDRESS APPROVAL (W-withdraw-09, J-wallet-04 #5). A withdrawal address the customer saves starts `pending`: no
 * money goes to it, and its cooling-off has not started. The customer approves it by email or from another signed-in
 * device, and only then does the cooling-off start. A thief holding one signed-in session therefore also needs the
 * customer's mailbox or a second sign-in before an address of theirs can ever be paid.
 *
 * - BY EMAIL. `requestMail` makes a single-use link and asks identity to mail it to the address on the customer's account
 *   (`POST /internal/mail`, purpose `withdraw-address-approval`; identity holds the address, the bank never sees it). The
 *   link lives the owner's `BANK_ADDRESS_APPROVAL_LINK_MINUTES` (blank refuses `bank.address_approval_link_unset`). Only the
 *   newest link of an entry works: asking again replaces the one before. A used, replaced or expired link approves
 *   nothing and says which. The bank keeps only the token's sha256; identity's acceptance means the mail was queued, not
 *   delivered, and the customer is told no more than that. Opening the link approves after a fresh confirmation (the
 *   router asks for the step-up scope).
 * - FROM ANOTHER DEVICE. `approveOnDevice` approves from a device that did not save the entry, after a fresh
 *   confirmation (the router asks for the step-up scope). The entry keeps the sign-in (`fam`) and trusted device (`dev`)
 *   its access token named; `deviceComparison` says whether the approving token's are a different device. The session id
 *   is not used: it changes on every refresh. Identity is then asked whether the approving device may be relied on
 *   (`deviceMayApprove`): still trusted, proved by a mailed code or by being the sign-up device, and the owner's
 *   new-device check on. Otherwise anyone holding the password and second factor could sign in on a second browser and
 *   approve from it without the mailbox.
 *
 * Both refuse while the customer's security lock holds, like adding an address does. Approving twice changes nothing.
 */

export const BANK_ADDRESS_APPROVAL_LINK_ENV = 'BANK_ADDRESS_APPROVAL_LINK_MINUTES';
/** Identity refuses a link shown as valid more than seven days ahead. */
const MAX_LINK_MINUTES = 7 * 24 * 60;

/** The owner's link lifetime in whole minutes, 1 to seven days, or `bank.address_approval_link_unset`. */
export function requireApprovalLinkMinutes(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? '';
  const minutes = /^[1-9][0-9]{0,4}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isInteger(minutes) || minutes > MAX_LINK_MINUTES) {
    throw new BankError(
      `${BANK_ADDRESS_APPROVAL_LINK_ENV} is unset or not a whole number of minutes up to seven days, so no approval link is sent`,
      'bank.address_approval_link_unset',
    );
  }
  return minutes;
}

/** Identity's mail door, as svc-bank uses it. Throws a BankError the customer can be told about. */
export interface ApprovalMailPort {
  send(request: ServiceMailRequest): Promise<{ mailId: string }>;
}

/** No IDENTITY_URL: every request refuses, so a link is never shown as sent. */
export function unconfiguredApprovalMail(why = 'IDENTITY_URL is unset, so svc-bank cannot ask for an approval mail'): ApprovalMailPort {
  return {
    async send() {
      throw new BankError(why, 'bank.address_approval_mail_unavailable');
    },
  };
}

const FETCH_MS = 5_000;

/** Identity's refusals in the bank's words. Anything else is the mail door being unavailable. */
const IDENTITY_REFUSALS: Readonly<Record<string, { code: BankErrorCode; message: string }>> = {
  'identity.email_unproved': {
    code: 'bank.address_approval_email_unproved',
    message: 'Your account has no confirmed email address, so no approval link can be mailed',
  },
  'identity.account_not_active': {
    code: 'bank.address_approval_email_unproved',
    message: 'Your account cannot receive an approval link now',
  },
  'identity.mail_unwired': {
    code: 'bank.address_approval_mail_unavailable',
    message: 'No mail service is connected, so no approval link can be sent. Approve the address from another signed-in device',
  },
};

export function createIdentityApprovalMail(
  baseUrl: string,
  internalSecret: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): ApprovalMailPort {
  const target = `${baseUrl.replace(/\/+$/, '')}${SERVICE_MAIL_PATH}`;
  const sign = serviceCallSigner({ service: 'svc-bank', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  const unavailable = (why: string) =>
    new BankError(`The approval mail could not be asked for: ${why}`, 'bank.address_approval_mail_unavailable');
  return {
    async send(request) {
      const body = JSON.stringify(request);
      let response: Response;
      try {
        response = await fetchFn(target, {
          method: 'POST',
          headers: {
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
            'content-type': 'application/json',
          },
          body,
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_MS),
        });
      } catch (err) {
        throw unavailable(`identity did not answer (${err instanceof Error ? err.name : 'unknown'})`);
      }
      let answer: unknown;
      try {
        answer = await response.json();
      } catch {
        throw unavailable(`identity answered ${response.status} with no readable body`);
      }
      if (!response.ok) {
        const code = (answer as { code?: unknown } | null)?.code;
        const known = typeof code === 'string' ? IDENTITY_REFUSALS[code] : undefined;
        if (known) throw new BankError(known.message, known.code);
        throw unavailable(`identity refused (${response.status}${typeof code === 'string' ? ` ${code}` : ''})`);
      }
      const parsed = serviceMailAcceptedSchema.safeParse(answer);
      if (!parsed.success) throw unavailable('identity answered without a mail id');
      return { mailId: parsed.data.mailId };
    },
  };
}

/** One approval link, as stored. The token itself is never stored. */
export interface ApprovalLinkRow {
  id: string;
  userId: string;
  destinationId: string;
  seq: number;
  expiresAt: Date;
  createdAt: Date;
  mailedAt: Date | null;
  usedAt: Date | null;
}

export interface ApprovalLinkStore {
  /** A new link for the entry, numbered after the last one. */
  insert(input: { userId: string; destinationId: string; tokenHash: string; expiresAt: Date }): Promise<ApprovalLinkRow>;
  markMailed(id: string, mailId: string): Promise<void>;
  /** The link with this token hash, and the highest link number its entry has. */
  byToken(tokenHash: string): Promise<{ link: ApprovalLinkRow; newestSeq: number } | null>;
  /** Marks the link used now, once. False when it was already used. */
  markUsed(id: string): Promise<boolean>;
  /** The newest mailed link of each of the customer's entries. */
  newestMailed(userId: string): Promise<Map<string, ApprovalLinkRow>>;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

interface LinkRow {
  id: string;
  user_id: string;
  destination_id: string;
  seq: number;
  expires_at: Date;
  created_at: Date;
  mailed_at: Date | null;
  used_at: Date | null;
}

const toLink = (row: LinkRow): ApprovalLinkRow => ({
  id: row.id,
  userId: row.user_id,
  destinationId: row.destination_id,
  seq: row.seq,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  mailedAt: row.mailed_at,
  usedAt: row.used_at,
});

export function sqlApprovalLinks(sql: Sql): ApprovalLinkStore {
  return {
    async insert(input) {
      return transaction(sql, async (tx) => {
        // One numbering per entry: two requests at once take turns, so each gets its own number and its own mail key.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`destination-approval:${input.destinationId}`}))`;
        const rows = await tx<LinkRow[]>`
          INSERT INTO bank.destination_approval_links (user_id, destination_id, seq, token_hash, expires_at)
          SELECT ${input.userId}, ${input.destinationId}::uuid, coalesce(max(seq), 0) + 1, ${input.tokenHash}, ${input.expiresAt}
            FROM bank.destination_approval_links WHERE destination_id = ${input.destinationId}::uuid
          RETURNING id, user_id, destination_id, seq, expires_at, created_at, mailed_at, used_at
        `;
        return toLink(rows[0]!);
      });
    },
    async markMailed(id, mailId) {
      await sql`UPDATE bank.destination_approval_links SET mailed_at = now(), mail_id = ${mailId}::uuid WHERE id = ${id}::uuid AND mailed_at IS NULL`;
    },
    async byToken(tokenHash) {
      const rows = await sql<Array<LinkRow & { newest_seq: number }>>`
        SELECT l.id, l.user_id, l.destination_id, l.seq, l.expires_at, l.created_at, l.mailed_at, l.used_at,
               (SELECT max(seq) FROM bank.destination_approval_links n
                 WHERE n.destination_id = l.destination_id AND n.mailed_at IS NOT NULL)::int AS newest_seq
          FROM bank.destination_approval_links l
         WHERE l.token_hash = ${tokenHash}
      `;
      const row = rows[0];
      return row ? { link: toLink(row), newestSeq: row.newest_seq ?? row.seq } : null;
    },
    async markUsed(id) {
      const rows = await sql<Array<{ id: string }>>`
        UPDATE bank.destination_approval_links SET used_at = now() WHERE id = ${id}::uuid AND used_at IS NULL RETURNING id
      `;
      return rows.length === 1;
    },
    async newestMailed(userId) {
      const rows = await sql<LinkRow[]>`
        SELECT DISTINCT ON (destination_id) id, user_id, destination_id, seq, expires_at, created_at, mailed_at, used_at
          FROM bank.destination_approval_links
         WHERE user_id = ${userId} AND mailed_at IS NOT NULL
         ORDER BY destination_id, seq DESC
      `;
      return new Map(rows.map((row) => [row.destination_id, toLink(row)]));
    },
  };
}

/** In-memory links for tests: the same numbering and newest-link rules. */
export function memoryApprovalLinks(now: () => Date = () => new Date()): ApprovalLinkStore & { readonly rows: ApprovalLinkRow[] } {
  const rows: Array<ApprovalLinkRow & { tokenHash: string }> = [];
  const newestMailedSeq = (destinationId: string) =>
    Math.max(0, ...rows.filter((r) => r.destinationId === destinationId && r.mailedAt).map((r) => r.seq));
  return {
    rows,
    async insert(input) {
      const seq = Math.max(0, ...rows.filter((r) => r.destinationId === input.destinationId).map((r) => r.seq)) + 1;
      const row = {
        id: `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, '0')}`,
        userId: input.userId,
        destinationId: input.destinationId,
        seq,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        createdAt: now(),
        mailedAt: null as Date | null,
        usedAt: null as Date | null,
      };
      rows.push(row);
      return { ...row };
    },
    async markMailed(id) {
      const row = rows.find((r) => r.id === id);
      if (row && !row.mailedAt) row.mailedAt = now();
    },
    async byToken(tokenHash) {
      const row = rows.find((r) => r.tokenHash === tokenHash);
      return row ? { link: { ...row }, newestSeq: newestMailedSeq(row.destinationId) || row.seq } : null;
    },
    async markUsed(id) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.usedAt) return false;
      row.usedAt = now();
      return true;
    },
    async newestMailed(userId) {
      const out = new Map<string, ApprovalLinkRow>();
      for (const row of rows) {
        if (row.userId !== userId || !row.mailedAt) continue;
        const prior = out.get(row.destinationId);
        if (!prior || prior.seq < row.seq) out.set(row.destinationId, { ...row });
      }
      return out;
    },
  };
}

export interface AddressApprovalDeps {
  destinations: UserWithdrawDestinations;
  links: ApprovalLinkStore;
  mail: ApprovalMailPort;
  securityLock: SecurityLockPort;
  /** Identity's trusted devices: asked, each time, whether the approving device may approve. */
  devices: TrustedDevicePort;
  linkMinutesRaw: () => string | undefined;
  now?: () => Date;
}

async function pendingEntry(deps: AddressApprovalDeps, userId: string, destinationId: string): Promise<WithdrawDestination> {
  const row = (await deps.destinations.list(userId)).find((entry) => entry.destinationId === destinationId);
  if (!row) throw new BankError(`User ${userId} has no saved address ${destinationId}`, 'bank.withdraw_destination_missing');
  if (row.state !== 'pending') {
    throw new BankError('This address does not need approving: it was approved already', 'bank.address_approval_not_pending');
  }
  return row;
}

/**
 * The entry an approval names, as it stands: refuses one missing (`bank.withdraw_destination_missing`) or removed or
 * blocked since (`bank.address_approval_not_pending`). A waiting entry and one approved already are both returned, so
 * each caller answers an approved one as it is.
 */
async function approvableEntry(deps: AddressApprovalDeps, userId: string, destinationId: string): Promise<WithdrawDestination> {
  const entry = (await deps.destinations.list(userId)).find((row) => row.destinationId === destinationId);
  if (!entry) throw new BankError('The address to approve was removed from your address book', 'bank.withdraw_destination_missing');
  if (entry.state === 'blocked' || entry.state === 'archived') {
    throw new BankError('This address can no longer be approved: it was removed or blocked', 'bank.address_approval_not_pending');
  }
  return entry;
}

/** What the mail shows so the customer can tell which address they approve: asset, network, first and last characters. */
function detailOf(row: WithdrawDestination): string {
  const ref = row.ref.replace(/[^A-Za-z0-9]/g, '');
  const short = ref.length <= 12 ? ref : `${ref.slice(0, 6)}...${ref.slice(-4)}`;
  return `${row.assetId ?? ''} on ${row.network ?? ''}, ${short}`.replace(/[^A-Za-z0-9 .:,()_-]/g, '').slice(0, 120);
}

/**
 * Mail a single-use approval link for one pending entry. The link row is written first and the mail asked for under the
 * key `address-approval:<entry>:<n>`; a refused mail leaves a link that was never sent and so can never be used.
 */
export async function requestApprovalMail(
  deps: AddressApprovalDeps,
  input: { userId: string; destinationId: string },
): Promise<{ destinationId: string; expiresAt: string }> {
  const minutes = requireApprovalLinkMinutes(deps.linkMinutesRaw());
  await assertSecurityLockOpen(deps.securityLock, input.userId, 'approving a withdrawal address');
  const row = await pendingEntry(deps, input.userId, input.destinationId);
  const token = randomBytes(32).toString('base64url');
  const now = (deps.now ?? (() => new Date()))();
  // Whole seconds: the mail shows the time, and identity compares it as sent.
  const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + minutes * 60_000);
  const link = await deps.links.insert({ userId: input.userId, destinationId: row.destinationId, tokenHash: hashToken(token), expiresAt });
  const { mailId } = await deps.mail.send({
    key: `address-approval:${row.destinationId}:${link.seq}`,
    userId: input.userId,
    purpose: 'withdraw-address-approval',
    token,
    detail: detailOf(row),
    expiresAt: expiresAt.toISOString(),
  });
  await deps.links.markMailed(link.id, mailId);
  return { destinationId: row.destinationId, expiresAt: expiresAt.toISOString() };
}

const LINK_INVALID = () =>
  new BankError('This approval link is not one we sent you, or it belongs to another account', 'bank.address_approval_link_invalid');

/**
 * Approve the entry an emailed link names. The signed-in customer must be the one it was sent to. An entry approved
 * already is answered as it is, whatever the link's age (opening a link twice, or an older one, changes nothing); one
 * removed or blocked since refuses. For an entry still waiting, a replaced or expired link approves nothing and says which.
 *
 * A link whose `mailed_at` is unset is still taken: its token exists only in the mail identity accepted (the bank never
 * shows it), so it can be presented only if that mail went out and the bank then failed to record it.
 */
export async function approveByLink(deps: AddressApprovalDeps, input: { userId: string; token: string }): Promise<WithdrawDestination> {
  const token = input.token.trim();
  if (!TOKEN_RE.test(token)) throw LINK_INVALID();
  const found = await deps.links.byToken(hashToken(token));
  if (!found || found.link.userId !== input.userId) throw LINK_INVALID();
  const { link, newestSeq } = found;
  const entry = await approvableEntry(deps, input.userId, link.destinationId);
  if (entry.state !== 'pending') return entry;
  // Only the newest mailed link works; one never recorded as mailed is newest when it is the latest made.
  if (link.seq < newestSeq) {
    throw new BankError('A newer approval link was sent for this address. Use the newest one', 'bank.address_approval_link_replaced');
  }
  const now = (deps.now ?? (() => new Date()))();
  if (now.getTime() >= link.expiresAt.getTime()) {
    throw new BankError('This approval link has expired. Ask for a new one from your address book', 'bank.address_approval_link_expired');
  }
  // Used, yet the entry still waits: the link approved nothing, so it cannot approve now either.
  if (link.usedAt) throw LINK_INVALID();
  await assertSecurityLockOpen(deps.securityLock, input.userId, 'approving a withdrawal address');
  // The entry moves first (only from `pending`, so two openings at once both answer the approved entry), then the link is
  // spent. A crash in between leaves the entry approved and the link unspent, which approves nothing more.
  const approved = await deps.destinations.approve({ userId: input.userId, destinationId: link.destinationId, by: 'link' });
  await deps.links.markUsed(link.id);
  return approved;
}

/**
 * Whether an approving sign-in is on a different device from the one that saved the entry. Only trusted devices tell
 * devices apart: both tokens must name one (`dev`), and the approving one a sign-in too (`fam`; a token without one, such
 * as an API key, an older token or a frozen account's read-only session, is never an interactive sign-in to approve
 * from). A second sign-in is not a second device: a passkey sign-in names no device and may be the very browser that
 * saved the entry, so without both devices the answer is `unknown`, or `same` when it is the saving sign-in itself.
 */
export function deviceComparison(saved: SavedOn, approving: SavedOn): 'different' | 'same' | 'unknown' {
  const lower = (id: string | null) => (id === null ? null : id.toLowerCase());
  const [savedFam, approvingFam] = [lower(saved.fam), lower(approving.fam)];
  if (approvingFam === null) return 'unknown';
  const [savedDev, approvingDev] = [lower(saved.dev), lower(approving.dev)];
  if (savedDev !== null && approvingDev !== null) return savedDev === approvingDev ? 'same' : 'different';
  return savedFam === approvingFam ? 'same' : 'unknown';
}

/**
 * Approve a waiting entry from a signed-in device that did not save it. An entry approved already is answered as it is;
 * one removed or blocked refuses. The same device refuses `bank.address_approval_same_device`; a sign-in or device not
 * named on either token refuses `bank.address_approval_device_unknown` (the emailed link still works).
 */
export async function approveOnDevice(
  deps: AddressApprovalDeps,
  input: { userId: string; destinationId: string; approving: SavedOn },
): Promise<WithdrawDestination> {
  await assertSecurityLockOpen(deps.securityLock, input.userId, 'approving a withdrawal address');
  const entry = await approvableEntry(deps, input.userId, input.destinationId);
  if (entry.state !== 'pending') return entry;
  const saved = await deps.destinations.savedOn({ userId: input.userId, destinationId: entry.destinationId });
  const compared = saved === null ? 'unknown' : deviceComparison(saved, input.approving);
  if (compared === 'same') {
    throw new BankError(
      'This address was saved on this device, so it cannot be approved here. Approve it on another device where you are signed in, or by the emailed link',
      'bank.address_approval_same_device',
    );
  }
  if (compared === 'unknown') {
    throw new BankError(
      'This device cannot be told apart from the one that saved the address. Use the emailed link instead',
      'bank.address_approval_device_unknown',
    );
  }
  // `different` means both tokens name a device, so the approving one is named.
  if (!deviceMayApprove(await deps.devices.read(input.userId, input.approving.dev!))) {
    throw new BankError(
      'This device was not confirmed by an emailed code, so it cannot approve the address. Use the emailed link instead',
      'bank.address_approval_device_untrusted',
    );
  }
  return deps.destinations.approve({ userId: input.userId, destinationId: entry.destinationId, by: 'device' });
}

/** The newest mailed link per entry that still works now, for the book and the readiness answer. */
export async function openApprovalLinks(deps: Pick<AddressApprovalDeps, 'links' | 'now'>, userId: string): Promise<Map<string, string>> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const out = new Map<string, string>();
  for (const [destinationId, link] of await deps.links.newestMailed(userId)) {
    if (!link.usedAt && link.expiresAt.getTime() > now) out.set(destinationId, link.expiresAt.toISOString());
  }
  return out;
}
