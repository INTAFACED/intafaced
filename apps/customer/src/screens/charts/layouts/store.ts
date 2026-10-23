/**
 * The desk's account records: saved layouts (`trade.layouts`) and chart templates (`trade.chart-templates`). Both use the
 * compare-and-set account store the watchlists use; identity checks each write against the owner's limits and refuses with its
 * code, which the menu shows as words.
 */
import { z } from 'zod';
import {
  CHART_TEMPLATES_NAMESPACE,
  LAYOUTS_NAMESPACE,
  NO_LAYOUTS,
  chartTemplatesPreferenceSchema,
  chartTemplatesRequestId,
  layoutsPreferenceSchema,
  layoutsRequestId,
  type ChartTemplatesValue,
  type LayoutsValue,
} from '@intafaced/contracts/layouts-preferences';
import { useAccountRecord, type RecordStore } from '../../../features/watchlists/store';

const NO_TEMPLATES: ChartTemplatesValue = [];

/** The account's saved layouts and the deleted ones kept for recovery. */
export function useLayoutRecord(): RecordStore<LayoutsValue> {
  return useAccountRecord<LayoutsValue>(
    LAYOUTS_NAMESPACE,
    { read: layoutsPreferenceSchema, stored: layoutsPreferenceSchema.extend({ outcome: z.literal('stored') }) },
    layoutsRequestId,
    NO_LAYOUTS,
  );
}

/** The account's chart templates. */
export function useChartTemplates(): RecordStore<ChartTemplatesValue> {
  return useAccountRecord<ChartTemplatesValue>(
    CHART_TEMPLATES_NAMESPACE,
    { read: chartTemplatesPreferenceSchema, stored: chartTemplatesPreferenceSchema.extend({ outcome: z.literal('stored') }) },
    chartTemplatesRequestId,
    NO_TEMPLATES,
  );
}

/** The words a refusal code reads as. Unknown codes read as not saved, never as a guess at the cause. */
export type RefusalWords =
  | 'layout-unset'
  | 'layout-full'
  | 'restore-unset'
  | 'restore-full'
  | 'template-unset'
  | 'template-full'
  | 'too-large'
  | 'version'
  | 'not-saved';

export function refusalWords(code: string): RefusalWords {
  switch (code) {
    case 'identity.layout_cap_unset':
      return 'layout-unset';
    case 'identity.layout_cap_exceeded':
      return 'layout-full';
    case 'identity.layout_restore_unset':
      return 'restore-unset';
    case 'identity.layout_restore_list_full':
      return 'restore-full';
    case 'identity.chart_template_cap_unset':
      return 'template-unset';
    case 'identity.chart_template_cap_exceeded':
      return 'template-full';
    case 'identity.preferences_value_too_large':
      return 'too-large';
    case 'preferences.version_conflict':
      return 'version';
    default:
      return 'not-saved';
  }
}
