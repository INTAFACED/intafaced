import 'server-only';
import { type FounderCallContext, type FounderCallResult, founderRecordCall } from '@/lib/desk';
import { refusalOf } from '@/lib/agents-log';
import type { AlertsAction } from './model';
import {
  AGENTS_OPS_ALERTS_DESK,
  AGENTS_OPS_ALERTS_POLICY,
  AGENTS_OPS_ALERTS_EVALUATE,
  AGENTS_OPS_ALERTS_CREATE_RULE,
  AGENTS_OPS_ALERTS_SET_NOTIFICATIONS,
  AGENTS_OPS_ALERTS_SET_OVERRIDE,
  AGENTS_OPS_ALERTS_CHECK_RULE,
} from '@intafaced/contracts/agents-ops-alerts-procedures';

/**
 * The agent alert desk's hops (AG-analytics-02, AG-guardrails-02), always as the signed-in founder through svc-edge:
 * svc-agents stores the rules, runs the evaluator, keeps the alerts and holds the policy baseline and this
 * environment's overrides. Nothing is cached or kept here.
 */

export type AlertsAnswer =
  { readonly kind: 'ok'; readonly data: unknown } | { readonly kind: 'refused'; readonly code: string; readonly status: number };

export async function runAlerts(ctx: FounderCallContext, action: AlertsAction): Promise<AlertsAnswer> {
  const answer = async <T>(call: Promise<FounderCallResult<T>>): Promise<AlertsAnswer> => {
    const result = await call;
    return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
  };
  switch (action.action) {
    case 'desk':
      return answer(founderRecordCall(ctx, AGENTS_OPS_ALERTS_DESK, undefined));
    case 'policy':
      return answer(founderRecordCall(ctx, AGENTS_OPS_ALERTS_POLICY, undefined));
    case 'evaluate':
      return answer(founderRecordCall(ctx, AGENTS_OPS_ALERTS_EVALUATE, undefined));
    case 'createRule':
      return answer(
        founderRecordCall(ctx, AGENTS_OPS_ALERTS_CREATE_RULE, {
          name: action.name,
          measure: action.measure,
          windowMinutes: action.windowMinutes,
          ...(action.threshold !== null ? { threshold: action.threshold } : {}),
          ...(action.agentId !== null ? { agentId: action.agentId } : {}),
        }),
      );
    case 'setNotifications':
      return answer(founderRecordCall(ctx, AGENTS_OPS_ALERTS_SET_NOTIFICATIONS, { state: action.state }));
    case 'setOverride':
      return answer(founderRecordCall(ctx, AGENTS_OPS_ALERTS_SET_OVERRIDE, { dataClass: action.dataClass, choice: action.choice }));
    case 'checkRule':
      return answer(founderRecordCall(ctx, AGENTS_OPS_ALERTS_CHECK_RULE, { dataClass: action.dataClass, choice: action.choice }));
  }
}
