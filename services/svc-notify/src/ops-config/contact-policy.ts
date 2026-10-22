/**
 * Genuine-communication policy (BK-safe-02, bank-security-support-040).
 *
 * The owner publishes how we contact customers: the official domains our
 * messages come from, the statement that we never ask a customer to move money,
 * the channels we use, whether an SMS ever carries a link, and where to report a
 * phishing attempt. Every field is owner input; none is defaulted and no copy is
 * seeded. A version is append-only and needs a second person's approval. Until a
 * version exists the public read says `not_published`, never an empty policy.
 */

import type { CommandLog } from '../preferences/account.js';
import type { NoticeApprovalConsumer } from '../notices/board.js';
import { OpsConfigError, payloadHashOf, spendFourEyes } from './four-eyes.js';

export const CONTACT_CHANNELS = ['email', 'sms', 'push', 'in_app', 'phone'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export const CONTACT_POLICY_DOMAINS_MAX = 20;
export const CONTACT_POLICY_TEXT_MAX = 2000;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type ContactPolicyCopy = {
  readonly officialDomains: readonly string[];
  readonly neverAskStatement: string;
  readonly contactChannels: readonly ContactChannel[];
  readonly smsCarriesLinks: boolean;
  readonly phishingReport: string;
};

export type ContactPolicyRow = ContactPolicyCopy & {
  readonly version: number;
  readonly authorId: string;
  readonly approvalId: string;
  readonly createdAt: Date;
};

export type ContactPolicyInput = {
  readonly officialDomains?: readonly string[] | null;
  readonly neverAskStatement?: string | null;
  readonly contactChannels?: readonly string[] | null;
  readonly smsCarriesLinks?: boolean | null;
  readonly phishingReport?: string | null;
};

export type ContactPolicyWire =
  | { readonly status: 'not_published' }
  | {
      readonly status: 'published';
      readonly version: number;
      readonly publishedAt: string;
      readonly officialDomains: string[];
      readonly neverAskStatement: string;
      readonly contactChannels: ContactChannel[];
      readonly smsCarriesLinks: boolean;
      readonly phishingReport: string;
    };

export interface ContactPolicyStore {
  latest(): Promise<ContactPolicyRow | null>;
  append(
    input: ContactPolicyCopy & { authorId: string; approvalId: string; now: Date },
  ): Promise<{ status: 'inserted'; row: ContactPolicyRow } | { status: 'exists' }>;
}

export class MemoryContactPolicyStore implements ContactPolicyStore {
  private readonly rows: ContactPolicyRow[] = [];

  async latest(): Promise<ContactPolicyRow | null> {
    return this.rows[this.rows.length - 1] ?? null;
  }

  async append(
    input: ContactPolicyCopy & { authorId: string; approvalId: string; now: Date },
  ): Promise<{ status: 'inserted'; row: ContactPolicyRow } | { status: 'exists' }> {
    if (this.rows.some((r) => r.approvalId === input.approvalId)) return { status: 'exists' };
    const { now, ...rest } = input;
    const row: ContactPolicyRow = { ...rest, version: this.rows.length + 1, createdAt: now };
    this.rows.push(row);
    return { status: 'inserted', row };
  }
}

/** Refuses a blank field, a malformed domain, an unknown channel or over-long copy. Nothing is defaulted. */
export function validateContactPolicy(input: ContactPolicyInput): ContactPolicyCopy {
  const statement = input.neverAskStatement?.trim() ?? '';
  const report = input.phishingReport?.trim() ?? '';
  const domains = [...new Set((input.officialDomains ?? []).map((d) => d.trim().toLowerCase()))];
  const channels = [...new Set(input.contactChannels ?? [])];
  if (!statement || !report || domains.length === 0 || channels.length === 0 || typeof input.smsCarriesLinks !== 'boolean')
    throw new OpsConfigError('notify.contact_policy_field_unset');
  if (statement.length > CONTACT_POLICY_TEXT_MAX || report.length > CONTACT_POLICY_TEXT_MAX)
    throw new OpsConfigError('notify.contact_policy_too_long');
  if (domains.length > CONTACT_POLICY_DOMAINS_MAX || domains.some((d) => !DOMAIN_RE.test(d)))
    throw new OpsConfigError('notify.contact_policy_domain_invalid');
  if (channels.some((c) => !(CONTACT_CHANNELS as readonly string[]).includes(c)))
    throw new OpsConfigError('notify.contact_policy_channel_unknown');
  return {
    officialDomains: domains,
    neverAskStatement: statement,
    contactChannels: channels as ContactChannel[],
    smsCarriesLinks: input.smsCarriesLinks,
    phishingReport: report,
  };
}

function toWire(row: ContactPolicyRow | null): ContactPolicyWire {
  if (!row) return { status: 'not_published' };
  return {
    status: 'published',
    version: row.version,
    publishedAt: row.createdAt.toISOString(),
    officialDomains: [...row.officialDomains],
    neverAskStatement: row.neverAskStatement,
    contactChannels: [...row.contactChannels],
    smsCarriesLinks: row.smsCarriesLinks,
    phishingReport: row.phishingReport,
  };
}

type PublishReplay = { ok: true; policy: ContactPolicyWire } | { ok: false; code: string };

export class ContactPolicy {
  constructor(
    private readonly store: ContactPolicyStore,
    private readonly approvals: NoticeApprovalConsumer | null,
    private readonly commands: CommandLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The newest published version, or `not_published`. Signed-out readers see this. */
  async current(): Promise<ContactPolicyWire> {
    return toWire(await this.store.latest());
  }

  /** What a second person approves: the exact copy, bound to the version it replaces. */
  async proposal(input: ContactPolicyInput) {
    const copy = validateContactPolicy(input);
    const version = (await this.store.latest())?.version ?? 0;
    return { targetId: 'contact_policy', expectedVersion: String(version), payloadHash: payloadHashOf({ ...copy, version }) };
  }

  async publish(
    actorId: string,
    input: ContactPolicyInput & { clientRequestId: string; approvalId: string; operationId: string },
  ): Promise<ContactPolicyWire> {
    const replay = (await this.commands.find(actorId, 'publishContactPolicy', input.clientRequestId)) as PublishReplay | null;
    if (replay) {
      if (!replay.ok) throw new OpsConfigError(replay.code);
      return replay.policy;
    }
    const fail = async (code: string): Promise<never> => {
      await this.commands.put(actorId, 'publishContactPolicy', input.clientRequestId, { ok: false, code } satisfies PublishReplay);
      throw new OpsConfigError(code);
    };
    let copy: ContactPolicyCopy;
    let proposal: Awaited<ReturnType<ContactPolicy['proposal']>>;
    try {
      copy = validateContactPolicy(input);
      proposal = await this.proposal(copy);
    } catch (err) {
      if (err instanceof OpsConfigError) return fail(err.code);
      throw err;
    }
    try {
      await spendFourEyes(this.approvals, { actorId, approvalId: input.approvalId, operationId: input.operationId, ...proposal });
    } catch (err) {
      return fail(err instanceof OpsConfigError ? err.code : 'notify.approval_spent');
    }
    const written = await this.store.append({ ...copy, authorId: actorId, approvalId: input.approvalId, now: this.now() });
    if (written.status === 'exists') return fail('notify.approval_spent');
    const policy = toWire(written.row);
    await this.commands.put(actorId, 'publishContactPolicy', input.clientRequestId, { ok: true, policy } satisfies PublishReplay);
    return policy;
  }
}
