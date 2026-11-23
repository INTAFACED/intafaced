import type { SupportChartsLookup } from '@intafaced/contracts/support-charts-lookup';

/**
 * What the charts panel says about each part of a lookup (J-charts-desk-19 #1). Pure, so the panel and its tests read the
 * same words. A part that was not read says why; it never reads as "none".
 */
export type PartWords = { readonly state: 'read' | 'empty' | 'unread'; readonly text: string; readonly code: string | null };

const UNREAD_WHY: Record<'plane_dark' | 'unwired', (owner: string) => string> = {
  plane_dark: (owner) => `${owner} did not answer, so this was not read.`,
  unwired: (owner) => `svc-support has no connection to ${owner} on this deployment, so this was not read.`,
};

export function alertsWords(lookup: SupportChartsLookup): PartWords {
  const a = lookup.alerts;
  if (a.status === 'unread') return { state: 'unread', text: UNREAD_WHY[a.reason]('svc-notify'), code: a.reason };
  if (a.items.length === 0) return { state: 'empty', text: 'No price alerts.', code: null };
  const n = a.items.length;
  return {
    state: 'read',
    text: `${String(n)} price alert${n === 1 ? '' : 's'}${a.more ? ' (the newest shown; there are more)' : ''}.`,
    code: null,
  };
}

export function historyWords(lookup: SupportChartsLookup): PartWords {
  const a = lookup.alerts;
  if (a.status === 'unread') return { state: 'unread', text: UNREAD_WHY[a.reason]('svc-notify'), code: a.reason };
  const h = a.history;
  if (h.status === 'unread') {
    return { state: 'unread', text: 'The owner has not set how long alert history is kept, so it was not read.', code: h.reason };
  }
  if (h.items.length === 0) return { state: 'empty', text: `No alert has fired in the last ${String(h.retentionDays)} days.`, code: null };
  const n = h.items.length;
  return {
    state: 'read',
    text: `${String(n)} firing${n === 1 ? '' : 's'} in the last ${String(h.retentionDays)} days${h.more ? ' (the newest shown; there are more)' : ''}.`,
    code: null,
  };
}

export function layoutsWords(lookup: SupportChartsLookup): PartWords {
  const l = lookup.layouts;
  if (l.status === 'unread') return { state: 'unread', text: UNREAD_WHY[l.reason]('svc-identity'), code: l.reason };
  if (l.items.length === 0) return { state: 'empty', text: 'No saved layouts.', code: null };
  const n = l.items.length;
  return { state: 'read', text: `${String(n)} saved layout${n === 1 ? '' : 's'}.`, code: null };
}

/** The condition an alert watches, in words: "above 50000", "crosses 50000". */
export function conditionWords(condition: string, target: string): string {
  switch (condition) {
    case 'greater_than':
      return `above ${target}`;
    case 'less_than':
      return `below ${target}`;
    case 'crossing_up':
      return `crosses up through ${target}`;
    case 'crossing_down':
      return `crosses down through ${target}`;
    default:
      return `crosses ${target}`;
  }
}
