/**
 * Chart templates as pure functions: a template is a study set and its drawings, with the interval and style it opens with. It
 * applies to any market. The record is written through the account store (`useChartTemplates`).
 */
import type { ChartTemplate, ChartTemplatesValue } from '@intafaced/contracts/layouts-preferences';
import { cleanName, sameName } from './model';

export type TemplateOutcome =
  { ok: true; templates: ChartTemplatesValue; template: ChartTemplate } | { ok: false; why: 'name-needed' | 'name-taken' };

/** Save a template under a name. A taken name is refused unless `replace` says the person agreed to replace that template. */
export function saveTemplate(
  templates: ChartTemplatesValue,
  name: string,
  body: Omit<ChartTemplate, 'id' | 'name' | 'savedAt'>,
  now: string,
  newId: string,
  replace: boolean,
): TemplateOutcome {
  const label = cleanName(name);
  if (label === '') return { ok: false, why: 'name-needed' };
  const taken = templates.find((template) => sameName(template.name, label));
  if (taken && !replace) return { ok: false, why: 'name-taken' };
  const template: ChartTemplate = { ...body, id: taken ? taken.id : newId, name: label, savedAt: now };
  const next = taken ? templates.map((entry) => (entry.id === taken.id ? template : entry)) : [template, ...templates];
  return { ok: true, templates: next, template };
}

export function removeTemplate(templates: ChartTemplatesValue, id: string): ChartTemplatesValue {
  return templates.filter((template) => template.id !== id);
}

/** A new id for a record entry, in the contract's id form. Entry ids are not idempotency keys, so a random one is right here. */
export function newRecordId(prefix: string): string {
  const random = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}-${random}`;
}
