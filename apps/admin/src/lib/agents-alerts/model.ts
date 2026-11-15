/**
 * The agent alert desk (`/more-ops/agents/alerts`, AG-analytics-02, AG-guardrails-02): what the operator picks and what
 * the desk's one API route accepts. Shared by the page and the route; holds no data.
 */

export const MEASURES = ['refusal_rate', 'failure_rate', 'cost'] as const;
export type Measure = (typeof MEASURES)[number];
export const MEASURE_WORD: Record<Measure, string> = {
  refusal_rate: 'Refusal rate',
  failure_rate: 'Failure rate',
  cost: 'Cost',
};

export const DATA_CLASSES = ['own_data', 'market_data', 'draft_write', 'live_write'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const CLASS_WORD: Record<DataClass, string> = {
  own_data: 'Own-data tools',
  market_data: 'Market-data tools',
  draft_write: 'Draft-write tools',
  live_write: 'Live-write tools',
};

/** Strictest first, as svc-agents orders them. */
export const CHOICES = ['hand_off', 'ask_before', 'act_on_request', 'act_without_asking'] as const;
export type Choice = (typeof CHOICES)[number];
export const CHOICE_WORD: Record<Choice, string> = {
  hand_off: 'Hand it off to the person',
  ask_before: 'Ask before acting',
  act_on_request: 'Act when asked',
  act_without_asking: 'Act without asking',
};

/** A measure's value with its unit: rates are percent, cost is in the fee asset. */
export function valueWords(measure: Measure, value: string): string {
  return measure === 'cost' ? `${value} (fee asset)` : `${value}%`;
}

export type AlertsAction =
  | { readonly action: 'desk' }
  | { readonly action: 'policy' }
  | { readonly action: 'evaluate' }
  | {
      readonly action: 'createRule';
      readonly name: string;
      readonly measure: Measure;
      readonly threshold: string | null;
      readonly windowMinutes: number;
      readonly agentId: string | null;
    }
  | { readonly action: 'setNotifications'; readonly state: 'on' | 'down' }
  | { readonly action: 'setOverride'; readonly dataClass: DataClass; readonly choice: Choice }
  | { readonly action: 'checkRule'; readonly dataClass: DataClass; readonly choice: Choice };

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max ? value.trim() : null;

/**
 * The route's body, checked field by field. A blank threshold is passed on as absent, so svc-agents refuses it by its
 * own code and nothing is stored.
 */
export function parseAlertsAction(body: unknown): AlertsAction | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.action === 'desk' || b.action === 'policy' || b.action === 'evaluate') return { action: b.action };
  if (b.action === 'createRule') {
    const name = text(b.name, 80);
    const measure = MEASURES.includes(b.measure as Measure) ? (b.measure as Measure) : null;
    const windowMinutes = typeof b.windowMinutes === 'number' && Number.isInteger(b.windowMinutes) ? b.windowMinutes : null;
    if (!name || !measure || windowMinutes === null) return null;
    if (b.threshold !== undefined && b.threshold !== null && typeof b.threshold !== 'string') return null;
    const threshold = typeof b.threshold === 'string' && b.threshold.trim() !== '' ? b.threshold.trim().slice(0, 60) : null;
    return { action: 'createRule', name, measure, threshold, windowMinutes, agentId: text(b.agentId, 120) };
  }
  if (b.action === 'setNotifications')
    return b.state === 'on' || b.state === 'down' ? { action: 'setNotifications', state: b.state } : null;
  if (b.action === 'setOverride' || b.action === 'checkRule') {
    const dataClass = DATA_CLASSES.includes(b.dataClass as DataClass) ? (b.dataClass as DataClass) : null;
    const choice = CHOICES.includes(b.choice as Choice) ? (b.choice as Choice) : null;
    return dataClass && choice ? { action: b.action, dataClass, choice } : null;
  }
  return null;
}
