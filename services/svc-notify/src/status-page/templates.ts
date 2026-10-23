/**
 * Incident templates (SP-status-02): wording the founders keep for incidents they expect, grouped, picked when declaring
 * one. Nothing is seeded: with no template defined the picker is empty and no sample text appears anywhere.
 *
 * A template is keyed by an id the founder chooses. Defining an id again replaces its wording (and brings back a retired
 * one); defining the same wording again is a no-op. A template may name status page components, and then an impact, as an
 * incident must. The cap on how many active templates exist is a hard limit of the store, not an owner value.
 */
import { INCIDENT_IMPACTS, STATUS_COMPONENTS, STATUS_COMPONENT_PATTERN, type IncidentImpact } from '../notices/board.js';

export const TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;
export const TEMPLATES_MAX = 100;

export type TemplateCode =
  | 'status.template_invalid'
  | 'status.template_component_unknown'
  | 'status.template_impact_unset'
  | 'status.template_cap_reached'
  | 'status.template_not_found';

export class TemplateError extends Error {
  constructor(readonly code: TemplateCode) {
    super(code);
    this.name = 'TemplateError';
  }
}

export type IncidentTemplate = {
  readonly id: string;
  readonly name: string;
  readonly group: string | null;
  readonly title: string;
  readonly body: string;
  readonly impact: IncidentImpact | null;
  readonly components: readonly string[];
  readonly definedBy: string;
  readonly definedAt: string;
};

export type TemplateInput = {
  id: string;
  name: string;
  group?: string | null;
  title: string;
  body: string;
  impact?: string | null;
  components?: readonly string[] | null;
};

export interface TemplateStore {
  /** Active templates, by group then name. */
  list(): Promise<readonly IncidentTemplate[]>;
  find(id: string): Promise<IncidentTemplate | null>;
  /** Insert or replace one id, active again. Refuses (returns false) when it would take the active count above `max`. */
  put(template: IncidentTemplate, max: number): Promise<boolean>;
  /** Returns false when no active template has this id. */
  retire(id: string, by: string, at: Date): Promise<boolean>;
}

/** Trimmed text, null when blank, false when longer than `max`. */
const text = (value: string | null | undefined, max: number): string | null | false => {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed.length > max ? false : trimmed;
};

const sameWording = (a: IncidentTemplate, b: Omit<IncidentTemplate, 'definedBy' | 'definedAt'>) =>
  a.name === b.name &&
  a.group === b.group &&
  a.title === b.title &&
  a.body === b.body &&
  a.impact === b.impact &&
  JSON.stringify(a.components) === JSON.stringify(b.components);

export class IncidentTemplates {
  constructor(
    private readonly store: TemplateStore,
    /** The status page's own component ids; a template may name these or the built-in ones. */
    private readonly pageComponents: () => Promise<readonly string[]>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<readonly IncidentTemplate[]> {
    return this.store.list();
  }

  async define(by: string, input: TemplateInput): Promise<IncidentTemplate> {
    const id = input.id.trim();
    const name = text(input.name, 80);
    const group = text(input.group, 80);
    const title = text(input.title, 200);
    const body = text(input.body, 8000);
    if (!TEMPLATE_ID_PATTERN.test(id) || !name || !title || !body || group === false) throw new TemplateError('status.template_invalid');
    const impact = input.impact ?? null;
    if (impact !== null && !(INCIDENT_IMPACTS as readonly string[]).includes(impact)) throw new TemplateError('status.template_invalid');
    const components = [...new Set(input.components ?? [])];
    if (components.some((c) => !STATUS_COMPONENT_PATTERN.test(c))) throw new TemplateError('status.template_component_unknown');
    if (components.some((c) => !(STATUS_COMPONENTS as readonly string[]).includes(c))) {
      const defined = new Set(await this.pageComponents());
      if (components.some((c) => !(STATUS_COMPONENTS as readonly string[]).includes(c) && !defined.has(c)))
        throw new TemplateError('status.template_component_unknown');
    }
    // As on an incident: a component never reads as affected by an unnamed severity.
    if (components.length > 0 && impact === null) throw new TemplateError('status.template_impact_unset');
    const wording = { id, name, group, title, body, impact: impact as IncidentImpact | null, components };
    const existing = await this.store.find(id);
    if (existing && sameWording(existing, wording)) return existing;
    const template: IncidentTemplate = { ...wording, definedBy: by, definedAt: this.now().toISOString() };
    if (!(await this.store.put(template, TEMPLATES_MAX))) throw new TemplateError('status.template_cap_reached');
    return template;
  }

  async retire(by: string, id: string): Promise<void> {
    if (!(await this.store.retire(id, by, this.now()))) throw new TemplateError('status.template_not_found');
  }
}

export class MemoryTemplateStore implements TemplateStore {
  private readonly rows = new Map<string, IncidentTemplate>();

  async list(): Promise<readonly IncidentTemplate[]> {
    return [...this.rows.values()].sort(
      (a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  }

  async find(id: string): Promise<IncidentTemplate | null> {
    return this.rows.get(id) ?? null;
  }

  async put(template: IncidentTemplate, max: number): Promise<boolean> {
    if (!this.rows.has(template.id) && this.rows.size >= max) return false;
    this.rows.set(template.id, template);
    return true;
  }

  async retire(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}
