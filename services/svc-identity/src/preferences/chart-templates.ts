/**
 * The account's chart templates (`charts.templates`, C-embed-feed-ops-03, J-charts-desk-07 #6). The shape lives in
 * `@intafaced/contracts/chart-templates-preferences`; this file checks it. A template name over 40 characters, a value
 * that is not the shape, or more templates than the fixed guard are refused as invalid. A view setting only: nothing
 * here is read by an authorisation or a money path.
 */
import {
  CHART_TEMPLATES_NAMESPACE,
  chartTemplatesValueSchema,
  type ChartTemplatesValue,
} from '@intafaced/contracts/chart-templates-preferences';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { CHART_TEMPLATES_NAMESPACE };
export type { ChartTemplatesValue };

export function parseChartTemplates(value: unknown): ChartTemplatesValue {
  const parsed = chartTemplatesValueSchema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(PREFERENCES_VALUE_INVALID);
    (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
    throw error;
  }
  return parsed.data;
}
