/**
 * Identity message templates: versioned, append-only, two-person approved.
 *
 * A template is plain text with `{{name}}` merge fields. Each key declares the
 * fields it may use; a field outside that set is refused at save, so a template
 * cannot ask for data the sender does not have. The anti-phishing code and the
 * owner brand are merge fields, never literals. A sender resolves the version once
 * when it enqueues and renders that version, so a later edit does not change a
 * message already in flight. No copy is seeded: a key with no version resolves to
 * nothing and the sender refuses `notify.template_unset`.
 */

import type { ChannelStatus } from '../channels/registry.js';
import { ChannelRefusal, type OutOfAppChannel, type OutboundMessage, type NotificationChannel } from '../channels/channel.js';
import type { CommandLog } from '../preferences/account.js';
import type { NoticeApprovalConsumer } from '../notices/board.js';
import { OpsConfigError, payloadHashOf, spendFourEyes } from './four-eyes.js';

export const TEMPLATE_KEYS = [
  'recovery_code',
  'verification_code',
  'login_code',
  'registration_code',
  'security_notice',
  'kyc_decision',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

const COMMON_FIELDS = ['brand', 'antiPhishingCode'] as const;
const CODE_FIELDS = ['code', 'expiresInMinutes'] as const;

/** Fields each template may use. The code-bearing ones must carry `{{code}}`. */
export const TEMPLATE_FIELDS: Readonly<Record<TemplateKey, readonly string[]>> = {
  recovery_code: [...COMMON_FIELDS, ...CODE_FIELDS],
  verification_code: [...COMMON_FIELDS, ...CODE_FIELDS],
  login_code: [...COMMON_FIELDS, ...CODE_FIELDS],
  registration_code: [...COMMON_FIELDS, ...CODE_FIELDS],
  security_notice: [...COMMON_FIELDS, 'eventSummary', 'occurredAt'],
  kyc_decision: [...COMMON_FIELDS, 'decision'],
};

const REQUIRED_FIELDS: Readonly<Partial<Record<TemplateKey, readonly string[]>>> = {
  recovery_code: ['code'],
  verification_code: ['code'],
  login_code: ['code'],
  registration_code: ['code'],
  kyc_decision: ['decision'],
};

export const TEMPLATE_SUBJECT_MAX = 200;
export const TEMPLATE_BODY_MAX = 5000;

export type TemplateRow = {
  readonly key: TemplateKey;
  readonly version: number;
  readonly subject: string;
  readonly body: string;
  readonly authorId: string;
  readonly approvalId: string;
  readonly createdAt: Date;
};

export interface TemplateStore {
  /** Newest version per key. */
  latest(): Promise<readonly TemplateRow[]>;
  /** One exact version. */
  version(key: TemplateKey, version: number): Promise<TemplateRow | null>;
  history(key: TemplateKey): Promise<readonly TemplateRow[]>;
  append(input: {
    key: TemplateKey;
    subject: string;
    body: string;
    authorId: string;
    approvalId: string;
    now: Date;
  }): Promise<{ status: 'inserted'; row: TemplateRow } | { status: 'exists' }>;
}

export class MemoryTemplateStore implements TemplateStore {
  private readonly rows: TemplateRow[] = [];

  async latest(): Promise<readonly TemplateRow[]> {
    return TEMPLATE_KEYS.flatMap((key) => {
      const own = this.rows.filter((r) => r.key === key);
      const last = own[own.length - 1];
      return last ? [last] : [];
    });
  }

  async version(key: TemplateKey, version: number): Promise<TemplateRow | null> {
    return this.rows.find((r) => r.key === key && r.version === version) ?? null;
  }

  async history(key: TemplateKey): Promise<readonly TemplateRow[]> {
    return this.rows.filter((r) => r.key === key).reverse();
  }

  async append(input: {
    key: TemplateKey;
    subject: string;
    body: string;
    authorId: string;
    approvalId: string;
    now: Date;
  }): Promise<{ status: 'inserted'; row: TemplateRow } | { status: 'exists' }> {
    if (this.rows.some((r) => r.approvalId === input.approvalId)) return { status: 'exists' };
    const row: TemplateRow = {
      key: input.key,
      version: this.rows.filter((r) => r.key === input.key).length + 1,
      subject: input.subject,
      body: input.body,
      authorId: input.authorId,
      approvalId: input.approvalId,
      createdAt: input.now,
    };
    this.rows.push(row);
    return { status: 'inserted', row };
  }
}

const FIELD_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

function fieldsIn(text: string): string[] {
  return [...text.matchAll(FIELD_RE)].map((m) => m[1]!);
}

function isKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** Refuses an unknown key, an undeclared field, a stray brace, empty copy, or a code message with no code. */
export function validateTemplateCopy(key: string, subject: string, body: string): { key: TemplateKey; subject: string; body: string } {
  if (!isKey(key)) throw new OpsConfigError('notify.template_key_unknown');
  const s = subject.trim();
  const b = body.trim();
  if (!s || !b) throw new OpsConfigError('notify.template_copy_empty');
  if (s.length > TEMPLATE_SUBJECT_MAX || b.length > TEMPLATE_BODY_MAX) throw new OpsConfigError('notify.template_too_long');
  const declared = new Set(TEMPLATE_FIELDS[key]);
  const used = new Set<string>();
  for (const text of [s, b]) {
    // Whatever is left after valid fields are removed must hold no braces.
    if (/[{}]/.test(text.replace(FIELD_RE, ''))) throw new OpsConfigError('notify.template_syntax_invalid');
    for (const field of fieldsIn(text)) {
      if (!declared.has(field)) throw new OpsConfigError('notify.template_variable_unknown');
      used.add(field);
    }
  }
  for (const needed of REQUIRED_FIELDS[key] ?? []) {
    if (!used.has(needed)) throw new OpsConfigError('notify.template_variable_required');
  }
  return { key, subject: s, body: b };
}

export type RenderedTemplate = { readonly version: number; readonly subject: string; readonly body: string };

/** Fill one stored version. Every field it uses must be supplied: a blank is never guessed. */
export function renderTemplateRow(row: TemplateRow, values: Readonly<Record<string, string | number>>): RenderedTemplate {
  const fill = (text: string): string =>
    text.replace(FIELD_RE, (_all, name: string) => {
      const value = values[name];
      if (value === undefined || String(value) === '') throw new OpsConfigError('notify.template_variable_missing');
      return String(value);
    });
  return { version: row.version, subject: fill(row.subject), body: fill(row.body) };
}

/** Labelled TEST values for a preview or a test-send. Never a real code or address. */
export function sampleValues(key: TemplateKey): Record<string, string> {
  const samples: Record<string, string> = {
    brand: 'TEST brand',
    antiPhishingCode: 'TEST-APC',
    code: '000000',
    expiresInMinutes: 'TEST minutes',
    eventSummary: 'TEST event',
    occurredAt: 'TEST time',
    decision: 'TEST decision',
  };
  return Object.fromEntries(TEMPLATE_FIELDS[key].map((f) => [f, samples[f]!]));
}

export type TemplateWire = {
  readonly key: TemplateKey;
  readonly fields: string[];
  /** Newest version, or null when nothing is saved (a sender then refuses `notify.template_unset`). */
  readonly current: { version: number; subject: string; body: string; authorId: string; createdAt: string } | null;
};

type SetReplay = { ok: true; template: TemplateWire } | { ok: false; code: string };
type TestSendReplay = { ok: true; result: TestSendResult } | { ok: false; code: string };
export type TestSendResult = { status: 'accepted' | 'refused' | 'failed'; code: string | null; version: number };

export type TemplateSendDeps = {
  /** The actor's own confirmed address on a channel, or null. */
  readonly verifiedAddress: (userId: string, channel: OutOfAppChannel) => Promise<{ address: string; locale: string } | null>;
  readonly channel: (channel: OutOfAppChannel) => NotificationChannel;
  readonly status: () => readonly ChannelStatus[];
  readonly disabled: () => Promise<ReadonlySet<OutOfAppChannel>>;
};

export class MessageTemplates {
  constructor(
    private readonly store: TemplateStore,
    private readonly approvals: NoticeApprovalConsumer | null,
    private readonly commands: CommandLog,
    private readonly send: TemplateSendDeps | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<readonly TemplateWire[]> {
    const latest = new Map((await this.store.latest()).map((r) => [r.key, r]));
    return TEMPLATE_KEYS.map((key) => toWire(key, latest.get(key) ?? null));
  }

  async history(key: string): Promise<readonly TemplateRow[]> {
    if (!isKey(key)) throw new OpsConfigError('notify.template_key_unknown');
    return this.store.history(key);
  }

  /** A sender calls this once when it enqueues and keeps the row: that version is the one it renders. */
  async resolve(key: TemplateKey): Promise<TemplateRow> {
    const row = (await this.store.latest()).find((r) => r.key === key);
    if (!row) throw new OpsConfigError('notify.template_unset');
    return row;
  }

  async proposal(input: { key: string; subject: string; body: string }) {
    const copy = validateTemplateCopy(input.key, input.subject, input.body);
    const version = (await this.store.history(copy.key)).length;
    return {
      targetId: copy.key,
      expectedVersion: String(version),
      payloadHash: payloadHashOf({ key: copy.key, subject: copy.subject, body: copy.body, version }),
    };
  }

  /** Render a saved version (or the newest) with TEST samples, overridden by whatever the caller supplies. */
  async preview(input: { key: string; version?: number; values?: Record<string, string | number> }) {
    if (!isKey(input.key)) throw new OpsConfigError('notify.template_key_unknown');
    const row =
      input.version == null
        ? (await this.store.latest()).find((r) => r.key === input.key)
        : await this.store.version(input.key, input.version);
    if (!row) throw new OpsConfigError('notify.template_unset');
    return { sample: true as const, ...renderTemplateRow(row, { ...sampleValues(input.key), ...(input.values ?? {}) }) };
  }

  async set(
    actorId: string,
    input: { key: string; subject: string; body: string; clientRequestId: string; approvalId: string; operationId: string },
  ): Promise<TemplateWire> {
    const replay = (await this.commands.find(actorId, 'setTemplate', input.clientRequestId)) as SetReplay | null;
    if (replay) {
      if (!replay.ok) throw new OpsConfigError(replay.code);
      return replay.template;
    }
    const fail = async (code: string): Promise<never> => {
      await this.commands.put(actorId, 'setTemplate', input.clientRequestId, { ok: false, code } satisfies SetReplay);
      throw new OpsConfigError(code);
    };
    let proposal: Awaited<ReturnType<MessageTemplates['proposal']>>;
    let copy: { key: TemplateKey; subject: string; body: string };
    try {
      copy = validateTemplateCopy(input.key, input.subject, input.body);
      proposal = await this.proposal(copy);
    } catch (err) {
      return fail(err instanceof OpsConfigError ? err.code : 'notify.template_syntax_invalid');
    }
    try {
      await spendFourEyes(this.approvals, {
        actorId,
        approvalId: input.approvalId,
        operationId: input.operationId,
        payloadHash: proposal.payloadHash,
        targetId: proposal.targetId,
        expectedVersion: proposal.expectedVersion,
      });
    } catch (err) {
      return fail(err instanceof OpsConfigError ? err.code : 'notify.approval_spent');
    }
    const written = await this.store.append({ ...copy, authorId: actorId, approvalId: input.approvalId, now: this.now() });
    if (written.status === 'exists') return fail('notify.approval_spent');
    const template = toWire(copy.key, written.row);
    await this.commands.put(actorId, 'setTemplate', input.clientRequestId, { ok: true, template } satisfies SetReplay);
    return template;
  }

  /**
   * Send the newest version, filled with TEST values, to the actor's own confirmed
   * address on one channel. Never to an address in the request: there is none.
   */
  async testSend(actorId: string, input: { key: string; channel: OutOfAppChannel; clientRequestId: string }): Promise<TestSendResult> {
    const replay = (await this.commands.find(actorId, 'testSendTemplate', input.clientRequestId)) as TestSendReplay | null;
    if (replay) {
      if (!replay.ok) throw new OpsConfigError(replay.code);
      return replay.result;
    }
    const fail = async (code: string): Promise<never> => {
      await this.commands.put(actorId, 'testSendTemplate', input.clientRequestId, { ok: false, code } satisfies TestSendReplay);
      throw new OpsConfigError(code);
    };
    if (!this.send) return fail('notify.test_send_unavailable');
    if (!isKey(input.key)) return fail('notify.template_key_unknown');
    const row = (await this.store.latest()).find((r) => r.key === input.key);
    if (!row) return fail('notify.template_unset');
    const target = await this.send.verifiedAddress(actorId, input.channel);
    if (!target) return fail('notify.test_send_target_unverified');
    const rendered = renderTemplateRow(row, sampleValues(input.key));
    const finish = async (status: TestSendResult['status'], code: string | null): Promise<TestSendResult> => {
      const result = { status, code, version: row.version };
      await this.commands.put(actorId, 'testSendTemplate', input.clientRequestId, { ok: true, result } satisfies TestSendReplay);
      return result;
    };
    if ((await this.send.disabled()).has(input.channel)) return finish('refused', 'channel.disabled');
    const channel = this.send.channel(input.channel);
    const message: OutboundMessage = {
      notificationId: `template-test:${input.clientRequestId}`,
      userId: actorId,
      channel: input.channel,
      kind: `template.test.${input.key}`,
      severity: 'info',
      titleKey: `notify.template.${input.key}.title`,
      bodyKey: `notify.template.${input.key}.body`,
      title: `TEST: ${rendered.subject}`,
      body: rendered.body,
      href: null,
      locale: target.locale,
      address: target.address,
      idempotencyKey: `template-test:${actorId}:${input.clientRequestId}`,
    };
    try {
      await channel.deliver(message);
      return await finish('accepted', null);
    } catch (err) {
      if (err instanceof ChannelRefusal) return finish('refused', err.code);
      // Attempted, outcome not a refusal: the caller sees it failed, not that the transport said no.
      return finish('failed', null);
    }
  }
}

function toWire(key: TemplateKey, row: TemplateRow | null): TemplateWire {
  return {
    key,
    fields: [...TEMPLATE_FIELDS[key]],
    current: row
      ? { version: row.version, subject: row.subject, body: row.body, authorId: row.authorId, createdAt: row.createdAt.toISOString() }
      : null,
  };
}
