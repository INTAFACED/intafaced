/**
 * SP-desk-02 — macros and agent signatures.
 *
 * A lead writes a macro (a title, a unique shortcode, a body) at a revision with a reason; each write is a compare-and-set on the revision the lead read, logged
 * with who and why. A macro naming a placeholder no request can fill is refused before anything is written. Any agent
 * applies a macro to a request they may see: svc-support fills the placeholders from that request and writes nothing, so
 * nothing reaches the customer until the agent sends. Each agent writes only their own signature, also at a revision.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  fillSupportMacro,
  supportMacroUnfilled,
  supportMacroUnknownPlaceholders,
  type SupportMacro,
  type SupportMacroApplied,
  type SupportMacroSaveInput,
  type SupportSignature,
  type SupportTicket,
} from '@intafaced/contracts';
import type { StaffMember } from './desk-staff.js';

export const MACRO_PLACEHOLDER_UNKNOWN = 'support.macro_placeholder_unknown' as const;
export const MACRO_PLACEHOLDER_BLANK = 'support.macro_placeholder_blank' as const;
export const MACRO_REVISION_STALE = 'support.macro_revision_stale' as const;
export const MACRO_NOT_FOUND = 'support.macro_not_found' as const;
export const SHORTCODE_TAKEN = 'support.shortcode_taken' as const;
export const SHORTCODE_RULE_UNSET = 'support.shortcode_rule_unset' as const;
export const SHORTCODE_TOO_SHORT = 'support.shortcode_too_short' as const;
export const MACRO_NOT_LEAD = 'support.not_lead' as const;

export class MacroError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MacroError';
  }
}

export interface MacroWrite {
  readonly macroId?: string;
  readonly title: string;
  readonly shortcode: string;
  readonly folder: string | null;
  readonly body: string;
  readonly expectedRevision: number;
  readonly actorId: string;
  readonly reason: string;
  readonly at: string;
}

/** What a write did: the macro as saved (or as a retried save first saved it), or why nothing was written. */
export type MacroPut = { readonly ok: true; readonly macro: SupportMacro } | { readonly ok: false; readonly code: string };

export interface MacroBook {
  list(): Promise<SupportMacro[]>;
  get(macroId: string): Promise<SupportMacro | null>;
  put(input: MacroWrite): Promise<MacroPut>;
  signature(userId: string): Promise<SupportSignature>;
  setSignature(input: { userId: string; signature: string; expectedRevision: number; at: string }): Promise<SupportSignature | null>;
}

/** The writer is part of it: another lead sending the same text is a new write, never a replay of the first. */
export function macroFingerprint(input: Pick<MacroWrite, 'actorId' | 'title' | 'shortcode' | 'folder' | 'body' | 'reason'>): string {
  return createHash('sha256')
    .update(JSON.stringify([input.actorId, input.title, input.shortcode, input.folder, input.body, input.reason]))
    .digest('hex');
}

type Logged = { readonly fingerprint: string; readonly after: SupportMacro };

/**
 * The one decision both books make under their lock. `current` is the macro the write targets (by id, or by shortcode on
 * a create); `byShortcode` is whichever macro holds the shortcode; `logged` is the log row at the revision this write would make.
 */
function decide(
  input: MacroWrite,
  current: SupportMacro | null,
  byShortcode: SupportMacro | null,
  logged: (macroId: string, revision: number) => Logged | undefined,
): MacroPut | { readonly write: SupportMacro } {
  const fingerprint = macroFingerprint(input);
  if (input.macroId !== undefined && current === null) return { ok: false, code: MACRO_NOT_FOUND };
  // A retry of a write that already landed answers it: same macro, the next revision, the same content and reason.
  const target = current ?? byShortcode;
  if (target && target.revision === input.expectedRevision + 1) {
    const hit = logged(target.id, target.revision);
    if (hit && hit.fingerprint === fingerprint) return { ok: true, macro: hit.after };
  }
  if (input.macroId === undefined) {
    if (byShortcode) return { ok: false, code: input.expectedRevision === 0 ? SHORTCODE_TAKEN : MACRO_REVISION_STALE };
    if (input.expectedRevision !== 0) return { ok: false, code: MACRO_REVISION_STALE };
  } else {
    if (current!.revision !== input.expectedRevision) return { ok: false, code: MACRO_REVISION_STALE };
    if (byShortcode && byShortcode.id !== current!.id) return { ok: false, code: SHORTCODE_TAKEN };
  }
  return {
    write: {
      id: current?.id ?? randomUUID(),
      title: input.title,
      shortcode: input.shortcode,
      folder: input.folder,
      body: input.body,
      revision: (current?.revision ?? 0) + 1,
      updatedBy: input.actorId,
      updatedAt: input.at,
    },
  };
}

function byFolderThenTitle(a: SupportMacro, b: SupportMacro): number {
  return (a.folder ?? '').localeCompare(b.folder ?? '') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export class MemoryMacroBook implements MacroBook {
  private readonly macros = new Map<string, SupportMacro>();
  private readonly log = new Map<string, Logged>();
  private readonly signatures = new Map<string, { signature: string; revision: number }>();

  async list(): Promise<SupportMacro[]> {
    return [...this.macros.values()].sort(byFolderThenTitle);
  }

  async get(macroId: string): Promise<SupportMacro | null> {
    return this.macros.get(macroId) ?? null;
  }

  async put(input: MacroWrite): Promise<MacroPut> {
    const current = input.macroId === undefined ? null : (this.macros.get(input.macroId) ?? null);
    const byShortcode = [...this.macros.values()].find((m) => m.shortcode === input.shortcode) ?? null;
    const outcome = decide(input, current, byShortcode, (id, revision) => this.log.get(`${id}:${revision}`));
    if (!('write' in outcome)) return outcome;
    this.macros.set(outcome.write.id, outcome.write);
    this.log.set(`${outcome.write.id}:${outcome.write.revision}`, { fingerprint: macroFingerprint(input), after: outcome.write });
    return { ok: true, macro: outcome.write };
  }

  async signature(userId: string): Promise<SupportSignature> {
    const row = this.signatures.get(userId);
    return row ? { signature: row.signature, revision: row.revision } : { signature: null, revision: 0 };
  }

  async setSignature(input: { userId: string; signature: string; expectedRevision: number }): Promise<SupportSignature | null> {
    const now = await this.signature(input.userId);
    const decided = decideSignature(now, input);
    if (decided === 'stale') return null;
    if (decided === 'replay') return now;
    this.signatures.set(input.userId, { signature: input.signature, revision: now.revision + 1 });
    return { signature: input.signature, revision: now.revision + 1 };
  }
}

/** A retry of the signature write that already landed answers it; any other moved revision is stale. */
function decideSignature(now: SupportSignature, input: { signature: string; expectedRevision: number }): 'write' | 'replay' | 'stale' {
  if (now.revision === input.expectedRevision) return 'write';
  if (now.revision === input.expectedRevision + 1 && now.signature === input.signature) return 'replay';
  return 'stale';
}

type PgMacro = {
  id: string;
  title: string;
  shortcode: string;
  folder: string | null;
  body: string;
  revision: number;
  updated_by: string;
  updated_at: Date | string;
};

const MACRO_COLUMNS = `id, title, shortcode, folder, body, revision, updated_by, updated_at`;

function fromRow(row: PgMacro): SupportMacro {
  return {
    id: row.id,
    title: row.title,
    shortcode: row.shortcode,
    folder: row.folder,
    body: row.body,
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class SqlMacroBook implements MacroBook {
  constructor(private readonly sql: Sql) {}

  async list(): Promise<SupportMacro[]> {
    const rows = await this.sql<PgMacro[]>`SELECT ${this.sql.unsafe(MACRO_COLUMNS)} FROM support.desk_macros`;
    return rows.map(fromRow).sort(byFolderThenTitle);
  }

  async get(macroId: string): Promise<SupportMacro | null> {
    const rows = await this.sql<PgMacro[]>`SELECT ${this.sql.unsafe(MACRO_COLUMNS)} FROM support.desk_macros WHERE id = ${macroId}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async put(input: MacroWrite): Promise<MacroPut> {
    return this.sql.begin(async (tx) => {
      // One macro write at a time: the shortcode check and the revision check stay true until this write lands.
      await tx`SELECT pg_advisory_xact_lock(hashtext('support.desk_macros'))`;
      const current =
        input.macroId === undefined
          ? null
          : ((await tx<PgMacro[]>`SELECT ${tx.unsafe(MACRO_COLUMNS)} FROM support.desk_macros WHERE id = ${input.macroId}`).map(
              fromRow,
            )[0] ?? null);
      const byShortcode =
        (await tx<PgMacro[]>`SELECT ${tx.unsafe(MACRO_COLUMNS)} FROM support.desk_macros WHERE shortcode = ${input.shortcode}`).map(
          fromRow,
        )[0] ?? null;
      const target = current ?? byShortcode;
      const logged = target
        ? (
            await tx<{ fingerprint: string; after: SupportMacro }[]>`
              SELECT fingerprint, after FROM support.desk_macro_log WHERE macro_id = ${target.id} AND revision = ${target.revision}
            `
          )[0]
        : undefined;
      const outcome = decide(input, current, byShortcode, (id, revision) =>
        target && id === target.id && revision === target.revision ? logged : undefined,
      );
      if (!('write' in outcome)) return outcome;
      const next = outcome.write;
      if (current === null) {
        await tx`
          INSERT INTO support.desk_macros (id, title, shortcode, folder, body, revision, updated_by, updated_at)
          VALUES (${next.id}, ${next.title}, ${next.shortcode}, ${next.folder}, ${next.body}, ${next.revision}, ${next.updatedBy}, ${next.updatedAt})
        `;
      } else {
        await tx`
          UPDATE support.desk_macros
          SET title = ${next.title}, shortcode = ${next.shortcode}, folder = ${next.folder}, body = ${next.body}, revision = ${next.revision},
              updated_by = ${next.updatedBy}, updated_at = ${next.updatedAt}
          WHERE id = ${next.id}
        `;
      }
      await tx`
        INSERT INTO support.desk_macro_log (macro_id, revision, fingerprint, after, actor_id, reason, at)
        VALUES (${next.id}, ${next.revision}, ${macroFingerprint(input)}, ${tx.json(next as never)}, ${input.actorId}, ${input.reason}, ${input.at})
      `;
      return { ok: true, macro: next } as const;
    }) as Promise<MacroPut>;
  }

  async signature(userId: string): Promise<SupportSignature> {
    const rows = await this.sql<{ signature: string; revision: number }[]>`
      SELECT signature, revision FROM support.staff_signatures WHERE user_id = ${userId}
    `;
    return rows[0] ? { signature: rows[0].signature, revision: rows[0].revision } : { signature: null, revision: 0 };
  }

  async setSignature(input: { userId: string; signature: string; expectedRevision: number; at: string }): Promise<SupportSignature | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<{ signature: string; revision: number }[]>`
        SELECT signature, revision FROM support.staff_signatures WHERE user_id = ${input.userId} FOR UPDATE
      `;
      const now: SupportSignature = rows[0]
        ? { signature: rows[0].signature, revision: rows[0].revision }
        : { signature: null, revision: 0 };
      const decided = decideSignature(now, input);
      if (decided === 'stale') return null;
      if (decided === 'replay') return now;
      const revision = now.revision + 1;
      // A first signature racing another first signature by the same person: the key refuses the second, read as stale.
      const written = await tx<{ revision: number }[]>`
        INSERT INTO support.staff_signatures (user_id, signature, revision, updated_at)
        VALUES (${input.userId}, ${input.signature}, ${revision}, ${input.at})
        ON CONFLICT (user_id) DO UPDATE SET signature = EXCLUDED.signature, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at
          WHERE support.staff_signatures.revision = ${now.revision}
        RETURNING revision
      `;
      if (written.length > 0) return { signature: input.signature, revision };
      // The other first write won: the same text is this write's retry, anything else is stale.
      const won = await tx<{ signature: string; revision: number }[]>`
        SELECT signature, revision FROM support.staff_signatures WHERE user_id = ${input.userId}
      `;
      return won[0]?.signature === input.signature && won[0].revision === revision ? { signature: won[0].signature, revision } : null;
    }) as Promise<SupportSignature | null>;
  }
}

/** The desk's macros and signatures, behind the lead rule and the request's own visibility. */
export class DeskMacros {
  constructor(
    private readonly book: MacroBook,
    private readonly support: {
      listStaff(): Promise<StaffMember[]>;
      getTicket(input: { userId: string; ticketId: string; asOperator?: boolean }): Promise<SupportTicket>;
    },
    /** The shortcode's minimum length, an owner value; null (blank) refuses every save. */
    private readonly shortcodeMin: number | null,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async list(): Promise<SupportMacro[]> {
    return this.book.list();
  }

  /** A lead creates or changes a macro. A placeholder no request can fill refuses before anything is written. */
  async save(actorId: string, input: SupportMacroSaveInput): Promise<SupportMacro> {
    const actor = (await this.support.listStaff()).find((member) => member.userId === actorId);
    if (actor?.role !== 'lead') throw new MacroError(MACRO_NOT_LEAD);
    if (this.shortcodeMin === null) throw new MacroError(SHORTCODE_RULE_UNSET);
    if ([...input.shortcode].length < this.shortcodeMin) throw new MacroError(SHORTCODE_TOO_SHORT);
    if (supportMacroUnknownPlaceholders(input.body).length > 0) throw new MacroError(MACRO_PLACEHOLDER_UNKNOWN);
    const put = await this.book.put({
      ...(input.macroId === undefined ? {} : { macroId: input.macroId }),
      title: input.title,
      shortcode: input.shortcode,
      folder: input.folder,
      body: input.body,
      expectedRevision: input.expectedRevision,
      actorId,
      reason: input.reason,
      at: this.now(),
    });
    if (!put.ok) throw new MacroError(put.code);
    return put.macro;
  }

  /**
   * The macro filled from one request the caller may see. Writes nothing: the text only goes into the agent's draft.
   * Someone else's request outside the caller's desk scope reads as not found, as `get` does. The desk holds no name
   * for a requester or an agent, so those stay unfilled and are named in `unfilled`: the agent fills them by hand, and
   * a reply still holding one is refused on send.
   */
  async apply(actorId: string, input: { ticketId: string; macroId: string }): Promise<SupportMacroApplied> {
    const ticket = await this.support.getTicket({ userId: actorId, ticketId: input.ticketId, asOperator: true });
    const macro = await this.book.get(input.macroId);
    if (!macro) throw new MacroError(MACRO_NOT_FOUND);
    const text = fillSupportMacro(macro.body, { 'requester.name': null, 'ticket.id': ticket.id, 'agent.name': null });
    return { macroId: macro.id, revision: macro.revision, text, unfilled: supportMacroUnfilled(text) };
  }

  async signature(userId: string): Promise<SupportSignature> {
    return this.book.signature(userId);
  }

  /** Only the caller's own signature: there is no user id to name someone else. A placeholder in it refuses. */
  async setSignature(userId: string, input: { signature: string; expectedRevision: number }): Promise<SupportSignature> {
    // A placeholder in a signature is never filled, so every reply carrying it would be refused on send.
    if (supportMacroUnfilled(input.signature).length > 0) throw new MacroError(MACRO_PLACEHOLDER_BLANK);
    const saved = await this.book.setSignature({ userId, ...input, at: this.now() });
    if (saved === null) throw new MacroError(MACRO_REVISION_STALE);
    return saved;
  }
}
