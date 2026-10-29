/**
 * SP-desk-02 — macros (saved replies with placeholders) and agent signatures.
 *
 * A macro has a title, a body and a shortcode, and is personal or shared with the desk. Its placeholders come from a
 * closed list and are filled on the server when the macro is applied, from the request and the people on it; a macro
 * cannot read any other field. Applying one only returns a draft and records the use: nothing is sent to the customer.
 *
 * The shortest shortcode is an owner value. Blank refuses every save with `support.shortcode_rule_unset`; no reference
 * minimum is filled in. A signature is the agent's own, stored here beside the staff record, and the console adds it to
 * the agent's public replies.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { identitySecretSet } from './identity-grounding-honesty.js';

export const SHORTCODE_RULE_UNSET = 'support.shortcode_rule_unset' as const;
export const SHORTCODE_INVALID = 'support.shortcode_invalid' as const;
export const SHORTCODE_TAKEN = 'support.shortcode_taken' as const;
export const PLACEHOLDER_UNKNOWN = 'support.macro_placeholder_unknown' as const;
export const PLACEHOLDER_UNREAD = 'support.macro_placeholder_unread' as const;
export const MACRO_NOT_FOUND = 'support.macro_not_found' as const;
export const MACRO_INVALID = 'support.macro_invalid' as const;
export const SIGNATURE_INVALID = 'support.signature_invalid' as const;
export const SHORTCODE_MIN_KEY = 'SUPPORT_MACRO_SHORTCODE_MIN' as const;

/** The only placeholders a macro may hold. None reads money or account data. */
export const MACRO_PLACEHOLDERS = ['requester.name', 'ticket.id', 'agent.name'] as const;
export type MacroPlaceholder = (typeof MACRO_PLACEHOLDERS)[number];

/** Transport bounds, not owner limits. */
export const MACRO_TITLE_MAX = 120;
export const MACRO_BODY_MAX = 10_000;
export const SHORTCODE_MAX = 32;
export const SIGNATURE_MAX = 500;

const SHORTCODE_RE = /^[a-z0-9_-]+$/;
const PLACEHOLDER_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

export class MacroError extends Error {
  constructor(
    readonly code: string,
    readonly missingKey?: string,
  ) {
    super(code);
    this.name = 'MacroError';
  }
}

export interface Macro {
  readonly id: string;
  readonly ownerId: string;
  readonly shared: boolean;
  readonly title: string;
  readonly shortcode: string;
  readonly body: string;
  readonly placeholders: readonly MacroPlaceholder[];
  readonly updatedAt: string;
}

export interface MacroSave {
  readonly ownerId: string;
  readonly shared: boolean;
  readonly title: string;
  readonly shortcode: string;
  readonly body: string;
  readonly at: string;
}

export interface MacroUse {
  readonly macroId: string;
  readonly ticketId: string;
  readonly by: string;
  readonly clientRequestId: string;
  readonly at: string;
}

export interface MacroBook {
  /** Shared macros and this person's own, newest first. */
  listVisible(viewerId: string): Promise<Macro[]>;
  get(id: string): Promise<Macro | null>;
  /** A new macro. A shortcode already used in the same scope (the desk, or this person's own) refuses. */
  create(input: MacroSave): Promise<Macro>;
  /** Records one use; the same (ticket, macro, client request id) again records nothing. */
  recordUse(use: MacroUse): Promise<void>;
  signatureOf(userId: string): Promise<string | null>;
  setSignature(input: { userId: string; signature: string | null; at: string }): Promise<string | null>;
}

/** Every placeholder in a body, or the first one outside the closed list as a refusal. */
export function placeholdersOf(body: string): MacroPlaceholder[] {
  const found: MacroPlaceholder[] = [];
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const name = match[1] ?? '';
    if (!(MACRO_PLACEHOLDERS as readonly string[]).includes(name)) throw new MacroError(PLACEHOLDER_UNKNOWN);
    if (!found.includes(name as MacroPlaceholder)) found.push(name as MacroPlaceholder);
  }
  return found;
}

/** The body with every placeholder filled. A value that could not be read refuses; nothing is left blank or guessed. */
export function fillPlaceholders(body: string, values: Readonly<Record<MacroPlaceholder, string | null>>): string {
  return body.replace(PLACEHOLDER_RE, (_, raw: string) => {
    const value = values[raw.trim() as MacroPlaceholder];
    if (value === null || value === undefined) throw new MacroError(PLACEHOLDER_UNREAD);
    return value;
  });
}

/** Checks a save against the owner's shortcode minimum and the transport bounds. */
export function checkMacro(input: MacroSave, shortcodeMin: number | null): MacroSave {
  if (shortcodeMin === null) throw new MacroError(SHORTCODE_RULE_UNSET, SHORTCODE_MIN_KEY);
  const title = input.title.trim();
  const body = input.body;
  const shortcode = input.shortcode.trim().toLowerCase();
  if (title === '' || title.length > MACRO_TITLE_MAX || body.trim() === '' || body.length > MACRO_BODY_MAX)
    throw new MacroError(MACRO_INVALID);
  if (shortcode.length < shortcodeMin || shortcode.length > SHORTCODE_MAX || !SHORTCODE_RE.test(shortcode))
    throw new MacroError(SHORTCODE_INVALID);
  placeholdersOf(body);
  return { ...input, title, shortcode };
}

export function checkSignature(signature: string | null): string | null {
  if (signature === null) return null;
  const text = signature.trim();
  if (text === '') return null;
  if (text.length > SIGNATURE_MAX) throw new MacroError(SIGNATURE_INVALID);
  return text;
}

const sameScope = (a: { shared: boolean; ownerId: string }, b: { shared: boolean; ownerId: string }) =>
  a.shared === b.shared && (a.shared || a.ownerId.toLowerCase() === b.ownerId.toLowerCase());

export class MemoryMacroBook implements MacroBook {
  private readonly macros: Macro[] = [];
  private readonly uses = new Map<string, MacroUse>();
  private readonly signatures = new Map<string, string>();

  async listVisible(viewerId: string): Promise<Macro[]> {
    const me = viewerId.toLowerCase();
    return this.macros.filter((m) => m.shared || m.ownerId.toLowerCase() === me).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Macro | null> {
    return this.macros.find((m) => m.id === id) ?? null;
  }

  async create(input: MacroSave): Promise<Macro> {
    if (this.macros.some((m) => m.shortcode === input.shortcode && sameScope(m, input))) throw new MacroError(SHORTCODE_TAKEN);
    const macro: Macro = {
      id: randomUUID(),
      ownerId: input.ownerId,
      shared: input.shared,
      title: input.title,
      shortcode: input.shortcode,
      body: input.body,
      placeholders: placeholdersOf(input.body),
      updatedAt: input.at,
    };
    this.macros.push(macro);
    return macro;
  }

  async recordUse(use: MacroUse): Promise<void> {
    const key = `${use.ticketId}:${use.macroId}:${use.clientRequestId}`;
    if (!this.uses.has(key)) this.uses.set(key, use);
  }

  useCount(macroId: string): number {
    return [...this.uses.values()].filter((u) => u.macroId === macroId).length;
  }

  async signatureOf(userId: string): Promise<string | null> {
    return this.signatures.get(userId.toLowerCase()) ?? null;
  }

  async setSignature(input: { userId: string; signature: string | null; at: string }): Promise<string | null> {
    if (input.signature === null) this.signatures.delete(input.userId.toLowerCase());
    else this.signatures.set(input.userId.toLowerCase(), input.signature);
    return input.signature;
  }
}

type MacroRow = {
  id: string;
  owner_id: string;
  shared: boolean;
  title: string;
  shortcode: string;
  body: string;
  updated_at: Date | string;
};

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const fromRow = (r: MacroRow): Macro => ({
  id: r.id,
  ownerId: r.owner_id,
  shared: r.shared,
  title: r.title,
  shortcode: r.shortcode,
  body: r.body,
  placeholders: placeholdersOf(r.body),
  updatedAt: iso(r.updated_at),
});

export class SqlMacroBook implements MacroBook {
  constructor(private readonly sql: Sql) {}

  async listVisible(viewerId: string): Promise<Macro[]> {
    const rows = await this.sql<MacroRow[]>`
      SELECT id, owner_id, shared, title, shortcode, body, updated_at FROM support.macros
      WHERE shared OR owner_id = ${viewerId} ORDER BY updated_at DESC, id
    `;
    return rows.map(fromRow);
  }

  async get(id: string): Promise<Macro | null> {
    const rows = await this.sql<MacroRow[]>`
      SELECT id, owner_id, shared, title, shortcode, body, updated_at FROM support.macros WHERE id = ${id}
    `;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async create(input: MacroSave): Promise<Macro> {
    // The scope key makes a shortcode unique per scope in the database itself: the desk for shared, the owner for personal.
    const scopeKey = input.shared ? 'shared' : `personal:${input.ownerId.toLowerCase()}`;
    const rows = await this.sql<MacroRow[]>`
      INSERT INTO support.macros (id, owner_id, shared, scope_key, title, shortcode, body, updated_at)
      VALUES (${randomUUID()}, ${input.ownerId}, ${input.shared}, ${scopeKey}, ${input.title}, ${input.shortcode}, ${input.body}, ${input.at})
      ON CONFLICT (scope_key, shortcode) DO NOTHING
      RETURNING id, owner_id, shared, title, shortcode, body, updated_at
    `;
    if (!rows[0]) throw new MacroError(SHORTCODE_TAKEN);
    return fromRow(rows[0]);
  }

  async recordUse(use: MacroUse): Promise<void> {
    await this.sql`
      INSERT INTO support.macro_uses (macro_id, ticket_id, used_by, client_request_id, used_at)
      VALUES (${use.macroId}, ${use.ticketId}, ${use.by}, ${use.clientRequestId}, ${use.at})
      ON CONFLICT (ticket_id, macro_id, client_request_id) DO NOTHING
    `;
  }

  async signatureOf(userId: string): Promise<string | null> {
    const rows = await this.sql<{ signature: string }[]>`SELECT signature FROM support.staff_signatures WHERE user_id = ${userId}`;
    return rows[0]?.signature ?? null;
  }

  async setSignature(input: { userId: string; signature: string | null; at: string }): Promise<string | null> {
    if (input.signature === null) {
      await this.sql`DELETE FROM support.staff_signatures WHERE user_id = ${input.userId}`;
      return null;
    }
    await this.sql`
      INSERT INTO support.staff_signatures (user_id, signature, updated_at) VALUES (${input.userId}, ${input.signature}, ${input.at})
      ON CONFLICT (user_id) DO UPDATE SET signature = EXCLUDED.signature, updated_at = EXCLUDED.updated_at
    `;
    return input.signature;
  }
}

/** A person's public handle, read from svc-identity per request. Null when it could not be read: never a guess. */
export interface HandleSource {
  handleOf(userId: string): Promise<string | null>;
}

export class DarkHandleSource implements HandleSource {
  async handleOf(): Promise<string | null> {
    return null;
  }
}

/** svc-identity's `GET /internal/handle/:userId`, service-signed like the account-state read. */
export function createHandleClient(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): HandleSource {
  if (!identitySecretSet(internalSecret)) return new DarkHandleSource();
  const url = baseUrl.replace(/\/$/, '');
  const sign = serviceCallSigner({ service: 'svc-support', audience: 'svc-identity', legacySecret: internalSecret, s2s });
  return {
    async handleOf(userId: string): Promise<string | null> {
      try {
        const target = `${url}/internal/handle/${encodeURIComponent(userId)}`;
        const response = await fetch(target, {
          method: 'GET',
          headers: {
            'content-type': 'application/json',
            ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
          },
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { userId?: unknown; handle?: unknown };
        // Bound to the person asked about, as the account-state read is.
        return body.userId === userId && typeof body.handle === 'string' && body.handle !== '' ? body.handle : null;
      } catch {
        return null;
      }
    },
  };
}
