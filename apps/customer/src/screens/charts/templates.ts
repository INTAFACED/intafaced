/**
 * Chart templates kept by the account (C-embed-feed-ops-03 / charts-desk-embed-feed-ops-017, J-charts-desk-07 #6): the study
 * set on a chart (each indicator with its inputs, colour and pane) and the chart's style, saved under a name and applied to
 * any other symbol or workbench. Drawings are anchored to one market's prices and times, so a template carries the study
 * set and leaves the drawings on the chart they were drawn on.
 *
 * Applying a template replaces the workbench's study set and style; the interval, the symbol and the parts of the chart the
 * workbench shows stay as they are.
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
  input: { name: string; studies: StudyStore; style: ChartStyle; scheme: ColourScheme },
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
