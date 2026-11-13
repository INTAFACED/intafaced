/**
 * Chart templates kept by the account (C-embed-feed-ops-03 / charts-desk-embed-feed-ops-017, J-charts-desk-07 #6): the study
 * set on a chart (each indicator with its inputs, colour and pane), the chart's style and its drawings, saved under a name and
 * applied to any other symbol or workbench. Drawings are anchored to one market's prices and times, so a template keeps
 * them with that market: applied on that market it places them, applied on another it says where they are kept.
 *
 * Applying a template replaces the workbench's study set and style and adds its drawings; the interval, the symbol and the
 * parts of the chart the workbench shows stay as they are.
 */
import { z } from 'zod';
import {
  CHART_TEMPLATES_NAMESPACE,
  CHART_TEMPLATE_NAME_MAX,
  chartTemplatesPreferenceSchema,
  chartTemplatesRequestId,
  EMPTY_CHART_TEMPLATES,
  type ChartTemplate,
  type ChartTemplatesValue,
} from '@intafaced/contracts/chart-templates-preferences';
import { useAccountRecord } from '../../features/preferences/account-record';
import { isStudyStore, type StudyStore } from './studies/model';
import { isChartStyle, isColourScheme, type ChartStyle, type ColourScheme } from './chart-style';
import { parseDoc, type DrawingDoc } from './drawings/model';

export type { ChartTemplate, ChartTemplatesValue };
export { CHART_TEMPLATE_NAME_MAX };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const findTemplate = (value: ChartTemplatesValue, name: string) => value.templates.find((one) => sameName(one.name, name));

function templateId(name: string, now: Date): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'template'}-${now.getTime().toString(36)}`;
}

/** Save the chart's studies and style as `name`: a new template, or the one with that name replaced (keeping its id). */
export function saveTemplate(
  value: ChartTemplatesValue,
  input: { name: string; studies: StudyStore; style: ChartStyle; scheme: ColourScheme; drawings?: { symbol: string; doc: DrawingDoc } },
  now: Date,
): ChartTemplatesValue {
  const name = input.name.trim();
  const existing = findTemplate(value, name);
  const template: ChartTemplate = {
    id: existing?.id ?? templateId(name, now),
    name,
    studies: input.studies.studies.map((study) => ({ ...study, inputs: { ...study.inputs }, hiddenOn: [...study.hiddenOn] })),
    ...(input.studies.panes ? { panes: input.studies.panes } : {}),
    legendAlways: input.studies.legendAlways,
    style: input.style,
    scheme: input.scheme,
    ...(input.drawings && input.drawings.doc.drawings.length > 0
      ? {
          drawings: {
            symbol: input.drawings.symbol,
            // A group is the chart's own arrangement; the drawings themselves go in the template.
            items: input.drawings.doc.drawings.map(({ groupId: _group, ...drawing }) => ({
              ...drawing,
              points: drawing.points.map((p) => ({ ...p })),
            })),
          },
        }
      : {}),
    savedAt: now.toISOString(),
  };
  const templates = existing ? value.templates.map((one) => (one.id === existing.id ? template : one)) : [...value.templates, template];
  return { templates };
}

/**
 * The study set a template gives a workbench, keeping what the workbench remembers of removed studies. Null when the
 * template holds a study this chart cannot draw: nothing is applied rather than part of it.
 */
export function studiesFrom(template: ChartTemplate, current: StudyStore): StudyStore | null {
  const next: StudyStore = {
    studies: template.studies.map((study) => ({ ...study, inputs: { ...study.inputs }, hiddenOn: [...study.hiddenOn] })),
    remembered: current.remembered,
    legendAlways: template.legendAlways,
    ...(template.panes ? { panes: template.panes } : {}),
  } as StudyStore;
  return isStudyStore(next) ? next : null;
}

/**
 * What a template's drawings do on a chart of `symbol`: on the market they were drawn on, the chart's drawings with the
 * template's added (one already there, by id, is not doubled); on any other market, nothing placed and where they are kept.
 * Null when a drawing is not one this chart can draw: nothing is placed rather than part of it.
 */
export function drawingsFrom(
  template: ChartTemplate,
  symbol: string,
  current: DrawingDoc,
): { placed: number; doc: DrawingDoc } | { keptFor: string; count: number } | null {
  const kept = template.drawings;
  if (!kept || kept.items.length === 0) return { placed: 0, doc: current };
  if (kept.symbol !== symbol) return { keptFor: kept.symbol, count: kept.items.length };
  const have = new Set(current.drawings.map((drawing) => drawing.id));
  const adding = kept.items.filter((item) => !have.has(item.id));
  const doc = parseDoc({ ...current, drawings: [...current.drawings, ...adding] });
  if (!doc || doc.drawings.length !== current.drawings.length + adding.length) return null;
  return { placed: adding.length, doc };
}

export const styleFrom = (template: ChartTemplate): { mode: ChartStyle; scheme: ColourScheme } | null =>
  isChartStyle(template.style) && isColourScheme(template.scheme) ? { mode: template.style, scheme: template.scheme } : null;

const storedSchema = chartTemplatesPreferenceSchema.extend({ outcome: z.literal('stored') });

/** The signed-in account's chart templates, and the writes on them. */
export function useChartTemplates() {
  return useAccountRecord<ChartTemplatesValue>({
    namespace: CHART_TEMPLATES_NAMESPACE,
    schema: chartTemplatesPreferenceSchema,
    stored: storedSchema,
    empty: EMPTY_CHART_TEMPLATES,
    requestId: chartTemplatesRequestId,
  });
}
