import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { refusalOf } from '@/lib/agents-log/server';
import type { AlertsAction } from './model';

/**
 * The agent alert desk's hops (AG-analytics-02, AG-guardrails-02), always as the signed-in founder through svc-edge:
 * svc-agents stores the rules, runs the evaluator, keeps the alerts and holds the policy baseline and this
 * environment's overrides. Nothing is cached or kept here.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const parseObject = (raw: unknown): Json | null => (isObject(raw) ? raw : null);
const parseDesk = (raw: unknown): Json | null => (isObject(raw) && Array.isArray(raw.rules) && Array.isArray(raw.alerts) ? raw : null);
const parsePolicy = (raw: unknown): Json | null => (isObject(raw) && Array.isArray(raw.classes) ? raw : null);
const parseWindows = (raw: unknown): Json | null => (isObject(raw) && Array.isArray(raw.windows) ? raw : null);

export type AlertsAnswer =
  { readonly kind: 'ok'; readonly data: unknown } | { readonly kind: 'refused'; readonly code: string; readonly status: number };

export async function runAlerts(ctx: FounderCallContext, action: AlertsAction): Promise<AlertsAnswer> {
  const answer = async (call: ReturnType<typeof founderCall<Json>>): Promise<AlertsAnswer> => {
    const result = await call;
    return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
  };
  switch (action.action) {
    case 'desk':
      return answer(founderCall(ctx, 'agents', 'opsAlerts.desk', 'GET', undefined, parseDesk));
    case 'policy':
      return answer(founderCall(ctx, 'agents', 'opsAlerts.policy', 'GET', undefined, parsePolicy));
    case 'evaluate':
      return answer(founderCall(ctx, 'agents', 'opsAlerts.evaluate', 'POST', undefined, parseWindows));
    case 'createRule':
      return answer(
        founderCall(
          ctx,
          'agents',
          'opsAlerts.createRule',
          'POST',
          {
            name: action.name,
            measure: action.measure,
            windowMinutes: action.windowMinutes,
            ...(action.threshold !== null ? { threshold: action.threshold } : {}),
            ...(action.agentId !== null ? { agentId: action.agentId } : {}),
          },
          parseObject,
        ),
      );
    case 'setOverride':
      return answer(
        founderCall(ctx, 'agents', 'opsAlerts.setOverride', 'POST', { dataClass: action.dataClass, choice: action.choice }, parsePolicy),
      );
    case 'checkRule':
      return answer(
        founderCall(ctx, 'agents', 'opsAlerts.checkRule', 'POST', { dataClass: action.dataClass, choice: action.choice }, parseObject),
      );
  }
}
