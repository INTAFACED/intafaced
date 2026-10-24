/**
 * Request forms per type and ticket fields (SP-tickets-03).
 *
 * A field is one question; a form is the ordered questions of one request type. A support lead defines both at a
 * revision, with a reason on the audit row. How many live forms and fields the desk keeps is an owner value with no
 * default: blank refuses `support.form_cap_unset` / `support.field_cap_unset` before anything is written. A request sent
 * with a form is checked against the stored definition (`supportFormValuesProblem`, the same rule the customer form
 * applies) before the ticket exists, and its answers are kept beside it with the form revision they were checked against.
 *
 * No kind carries money, an account or an identity copy; a decimal answer is a decimal string with no currency.
 */
import type { Sql } from 'postgres';
import {
  SUPPORT_FIELD_KINDS,
  supportFieldDefinitionProblem,
  supportFormValuesProblem,
  supportFormValuesTrimmed,
  type SupportCreateForm,
  type SupportField,
  type SupportFieldDefineInput,
  type SupportFieldKind,
  type SupportFieldValue,
  type SupportForm,
  type SupportFormDefineInput,
  type SupportRequestForms,
  type SupportTicketFieldValues,
} from '@intafaced/contracts';

export class RequestFormError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RequestFormError';
  }
}

type Kind = 'field' | 'form';
type Stored<T> = { definition: T; revision: number; updatedAt: string };
type Retirable = { retired?: boolean | undefined };
/** What one write did: written, refused for a moved revision, or refused because it would pass the live cap. */
export type PutResult = 'written' | 'stale' | 'cap_reached';

/**
 * The rows the forms keep. Each write is one compare-and-set on the revision; a stale revision writes nothing. A write
 * that leaves the definition live also counts the other live rows of its kind against `cap` in the same step, so two
 * leads writing at once cannot pass the owner's cap.
 */
export interface FormsStore {
  list<T>(kind: Kind): Promise<Stored<T>[]>;
  put<T extends Retirable>(
    kind: Kind,
    id: string,
    definition: T,
    expected: number,
    cap: number,
    at: string,
    by: string,
    reason: string,
  ): Promise<PutResult>;
  values(ticketId: string): Promise<SupportTicketFieldValues | null>;
  /** Keep the answers of a request once; a second write for the same request changes nothing. */
  recordValues(values: SupportTicketFieldValues, at: string): Promise<void>;
}

export interface RequestFormCaps {
  /** Live forms the desk may keep; null when the owner has not set it. */
  forms: number | null;
  fields: number | null;
}

export class RequestForms {
  constructor(
    private readonly store: FormsStore,
    private readonly caps: RequestFormCaps,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private async fields(): Promise<SupportField[]> {
    return (await this.store.list<SupportField>('field')).map((row) => ({
      ...row.definition,
      revision: row.revision,
      updatedAt: row.updatedAt,
    }));
  }

  private async forms(): Promise<SupportForm[]> {
    return (await this.store.list<SupportForm>('form')).map((row) => ({
      ...row.definition,
      revision: row.revision,
      updatedAt: row.updatedAt,
    }));
  }

  /** The live forms and the fields they use, for the customer request form. */
  async catalogue(): Promise<SupportRequestForms> {
    const forms = (await this.forms()).filter((form) => form.retired !== true).sort((a, b) => a.name.localeCompare(b.name));
    const used = new Set(forms.flatMap((form) => form.fields.map((entry) => entry.fieldId)));
    return { forms, fields: (await this.fields()).filter((field) => used.has(field.id)) };
  }

  /** Every form and field, retired ones too, for the desk. */
  async all(): Promise<SupportRequestForms> {
    return { forms: await this.forms(), fields: await this.fields() };
  }

  async defineField(input: SupportFieldDefineInput, by: string): Promise<SupportField> {
    if (this.caps.fields === null) throw new RequestFormError('the field cap is not set', 'support.field_cap_unset');
    if (!(SUPPORT_FIELD_KINDS as readonly string[]).includes(input.kind))
      throw new RequestFormError(`field kind ${input.kind} is not offered`, 'support.field_kind_unsupported');
    const { expectedRevision, reason, ...rest } = input;
    const definition = { ...rest, kind: input.kind as SupportFieldKind };
    const problem = supportFieldDefinitionProblem(definition);
    if (problem) throw new RequestFormError(problem, 'support.form_definition_invalid');
    const fields = await this.fields();
    if (definition.parent) {
      const parent = fields.find((field) => field.id === definition.parent!.fieldId);
      if (!parent || parent.kind !== 'choice')
        throw new RequestFormError('a dependent field needs a choice field as its parent', 'support.field_unknown');
      const parentValues = new Set((parent.options ?? []).map((option) => option.value));
      if (Object.keys(definition.parent.allowed).some((value) => !parentValues.has(value)))
        throw new RequestFormError('the parent has no such option', 'support.form_definition_invalid');
    }
    const prior = fields.find((field) => field.id === definition.id);
    if (prior && prior.kind !== definition.kind)
      throw new RequestFormError('a field keeps its kind; define a new field instead', 'support.form_definition_invalid');
    if (prior) await this.checkUsers(definition, fields);
    return this.write('field', definition, expectedRevision, this.caps.fields, by, reason) as Promise<SupportField>;
  }

  /**
   * A changed field must still fit everything live that uses it: no live form or dependent field may lose it by
   * retirement, and each live form that lists it must still be valid with the new definition (a removed option a
   * `showWhen` names, a new parent below it on the form).
   */
  private async checkUsers(definition: Omit<SupportField, 'revision' | 'updatedAt'>, fields: SupportField[]): Promise<void> {
    const forms = (await this.forms()).filter(
      (form) => form.retired !== true && form.fields.some((entry) => entry.fieldId === definition.id),
    );
    const dependents = fields.filter((field) => field.retired !== true && field.parent?.fieldId === definition.id);
    if (definition.retired === true) {
      if (forms.length > 0 || dependents.length > 0)
        throw new RequestFormError('a live form or field uses this field; change or retire it first', 'support.form_definition_invalid');
      return;
    }
    const values = new Set((definition.options ?? []).map((option) => option.value));
    if (dependents.some((field) => Object.keys(field.parent!.allowed).some((value) => !values.has(value))))
      throw new RequestFormError('a dependent field names an option this field no longer has', 'support.form_definition_invalid');
    const next = new Map(fields.map((field) => [field.id, field]));
    next.set(definition.id, { ...(next.get(definition.id) as SupportField), ...definition });
    for (const form of forms) assertFormFits(form, next);
  }

  async defineForm(input: SupportFormDefineInput, by: string): Promise<SupportForm> {
    if (this.caps.forms === null) throw new RequestFormError('the form cap is not set', 'support.form_cap_unset');
    const { expectedRevision, reason, ...definition } = input;
    // Retiring a form only takes it off the picker; it need not still fit fields that changed since.
    if (definition.retired !== true) assertFormFits(definition, new Map((await this.fields()).map((field) => [field.id, field])));
    return this.write('form', definition, expectedRevision, this.caps.forms, by, reason) as Promise<SupportForm>;
  }

  private async write<T extends { id: string } & Retirable>(
    kind: Kind,
    definition: T,
    expected: number,
    cap: number,
    by: string,
    reason: string,
  ) {
    const at = this.now();
    const result = await this.store.put(kind, definition.id, definition, expected, cap, at, by, reason);
    if (result === 'stale') throw new RequestFormError('the definition changed since it was read', 'support.form_revision_stale');
    if (result === 'cap_reached')
      throw kind === 'field'
        ? new RequestFormError('the field cap is reached', 'support.field_cap_reached')
        : new RequestFormError('the form cap is reached', 'support.form_cap_reached');
    return { ...definition, revision: expected + 1, updatedAt: at };
  }

  /** Check a request's answers against its live form. Throws the typed refusal; returns what to keep beside the ticket. */
  async check(form: SupportCreateForm): Promise<Omit<SupportTicketFieldValues, 'ticketId'>> {
    const stored = (await this.forms()).find((row) => row.id === form.formId && row.retired !== true);
    if (!stored) throw new RequestFormError('no such request type', 'support.form_unknown');
    const values = supportFormValuesTrimmed(form.values);
    const problem = supportFormValuesProblem(stored, await this.fields(), values);
    if (problem) throw new RequestFormError(`${problem.fieldId}: ${problem.problem}`, 'support.field_value_invalid');
    return { formId: stored.id, formRevision: stored.revision, values };
  }

  record(ticketId: string, checked: Omit<SupportTicketFieldValues, 'ticketId'>): Promise<void> {
    return this.store.recordValues({ ticketId, ...checked }, this.now());
  }

  values(ticketId: string): Promise<SupportTicketFieldValues | null> {
    return this.store.values(ticketId);
  }
}

/** Refuse a form whose questions do not fit the fields they name: unknown or retired, repeated, or depending on a field below. */
function assertFormFits(definition: Pick<SupportForm, 'fields'>, fields: ReadonlyMap<string, SupportField>): void {
  const seen = new Set<string>();
  for (const entry of definition.fields) {
    const field = fields.get(entry.fieldId);
    if (!field || field.retired === true) throw new RequestFormError(`no live field ${entry.fieldId}`, 'support.field_unknown');
    if (seen.has(entry.fieldId)) throw new RequestFormError('a field appears twice', 'support.form_definition_invalid');
    if (entry.showWhen) {
      const controller = fields.get(entry.showWhen.fieldId);
      if (!seen.has(entry.showWhen.fieldId) || !controller)
        throw new RequestFormError('a field can only depend on a field above it', 'support.form_definition_invalid');
      const fits =
        controller.kind === 'checkbox'
          ? typeof entry.showWhen.value === 'boolean'
          : controller.kind === 'choice' && (controller.options ?? []).some((option) => option.value === entry.showWhen!.value);
      if (!fits) throw new RequestFormError('the controlling field cannot hold that value', 'support.form_definition_invalid');
    }
    if (field.parent && !seen.has(field.parent.fieldId))
      throw new RequestFormError('a dependent field needs its parent above it on the form', 'support.form_definition_invalid');
    seen.add(entry.fieldId);
  }
}

export class MemoryFormsStore implements FormsStore {
  private readonly rows = new Map<string, Stored<unknown>>();
  private readonly answers = new Map<string, SupportTicketFieldValues>();
  readonly log: { kind: Kind; id: string; revision: number; by: string; reason: string; at: string }[] = [];

  async list<T>(kind: Kind): Promise<Stored<T>[]> {
    return [...this.rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, row]) => row as Stored<T>);
  }

  async put<T extends Retirable>(
    kind: Kind,
    id: string,
    definition: T,
    expected: number,
    cap: number,
    at: string,
    by: string,
    reason: string,
  ): Promise<PutResult> {
    const key = `${kind}:${id}`;
    if ((this.rows.get(key)?.revision ?? 0) !== expected) return 'stale';
    // Counted and written with no await between, so the check and the write are one step here too.
    const others = [...this.rows.entries()].filter(
      ([rowKey, row]) => rowKey.startsWith(`${kind}:`) && rowKey !== key && (row.definition as Retirable).retired !== true,
    ).length;
    if (definition.retired !== true && others >= cap) return 'cap_reached';
    this.rows.set(key, { definition, revision: expected + 1, updatedAt: at });
    this.log.push({ kind, id, revision: expected + 1, by, reason, at });
    return 'written';
  }

  async values(ticketId: string): Promise<SupportTicketFieldValues | null> {
    return this.answers.get(ticketId) ?? null;
  }

  async recordValues(values: SupportTicketFieldValues): Promise<void> {
    if (!this.answers.has(values.ticketId)) this.answers.set(values.ticketId, values);
  }
}

type DefinitionRow = { definition: unknown; revision: number; updated_at: Date | string };
const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();

export class SqlFormsStore implements FormsStore {
  constructor(private readonly sql: Sql) {}

  async list<T>(kind: Kind): Promise<Stored<T>[]> {
    const rows = await this.sql<DefinitionRow[]>`
      SELECT definition, revision, updated_at FROM support.request_definitions WHERE kind = ${kind} ORDER BY id
    `;
    return rows.map((row) => ({ definition: row.definition as T, revision: row.revision, updatedAt: iso(row.updated_at) }));
  }

  async put<T extends Retirable>(
    kind: Kind,
    id: string,
    definition: T,
    expected: number,
    cap: number,
    at: string,
    by: string,
    reason: string,
  ): Promise<PutResult> {
    return this.sql.begin(async (tx) => {
      // One writer per kind at a time, so the live count read here is the count the write lands on.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`support.request_definitions:${kind}`}))`;
      if (definition.retired !== true) {
        const [row] = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM support.request_definitions
          WHERE kind = ${kind} AND id <> ${id} AND coalesce((definition->>'retired')::boolean, false) = false
        `;
        if ((row?.n ?? 0) >= cap) return 'cap_reached' as const;
      }
      const written =
        expected === 0
          ? await tx`
              INSERT INTO support.request_definitions (kind, id, definition, revision, updated_at)
              VALUES (${kind}, ${id}, ${tx.json(definition as never)}, 1, ${at})
              ON CONFLICT (kind, id) DO NOTHING
              RETURNING revision
            `
          : await tx`
              UPDATE support.request_definitions
              SET definition = ${tx.json(definition as never)}, revision = revision + 1, updated_at = ${at}
              WHERE kind = ${kind} AND id = ${id} AND revision = ${expected}
              RETURNING revision
            `;
      if (written.length === 0) return 'stale' as const;
      await tx`
        INSERT INTO support.request_definition_log (kind, id, revision, definition, actor_id, reason, at)
        VALUES (${kind}, ${id}, ${expected + 1}, ${tx.json(definition as never)}, ${by}, ${reason}, ${at})
      `;
      return 'written' as const;
    }) as Promise<PutResult>;
  }

  async values(ticketId: string): Promise<SupportTicketFieldValues | null> {
    const rows = await this.sql<{ form_id: string; form_revision: number; field_values: Record<string, SupportFieldValue> }[]>`
      SELECT form_id, form_revision, field_values FROM support.ticket_field_values WHERE ticket_id = ${ticketId}
    `;
    const row = rows[0];
    return row ? { ticketId, formId: row.form_id, formRevision: row.form_revision, values: row.field_values } : null;
  }

  async recordValues(values: SupportTicketFieldValues, at: string): Promise<void> {
    await this.sql`
      INSERT INTO support.ticket_field_values (ticket_id, form_id, form_revision, field_values, created_at)
      VALUES (${values.ticketId}, ${values.formId}, ${values.formRevision}, ${this.sql.json(values.values as never)}, ${at})
      ON CONFLICT (ticket_id) DO NOTHING
    `;
  }
}
