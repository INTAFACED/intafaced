import { z } from 'zod';
import type { Resource } from '../../shared/resource';
import { parseAmount } from '../../shared/money';
import type { ApiClient, ApiResult } from '../../shared/api';
import { useApi } from '../session';
import { createMoneyClient } from './client';
import { bankReads, ruleSchema } from './contracts';
import { t } from './repeat-buy-copy';
import {
  funds,
  cadenceField,
  date,
  iso,
  positiveMoney,
  startsField,
  useBankRead,
  usePageLimit,
  type ActionSpec,
  useBankRecord,
} from './components';
import { BANK_AUTO_INVEST_LIST } from '@intafaced/contracts/bank-auto-invest-procedures';

/**
 * What Repeat buy (repeat-buy-room/repeat-buy.tsx) and the automatic investing rules (earn/AutoInvestRules.tsx) read and
 * send: the rules and their pause, resume and cancel reviews, the policy, and the review that sets a repeat buy up.
 * Each review is checked again against the bank's list, policy or balances before it is sent.
 */
export type Rule = z.infer<typeof ruleSchema>;
const refusal = (message: string): ApiResult<null> => ({ ok: false, reason: 'error', code: 'money.review_changed', message });
const readRefusal = (subject: string): ApiResult<null> => ({
  ok: false,
  reason: 'error',
  code: 'money.review_read_unavailable',
  message: t('readCheckFailed', { subject }),
});

/** The rules read and their pause, resume and cancel reviews; Repeat buy draws them here, the Earn room in its own look. */
export interface AutoInvestRulesRead {
  limit: number;
  setLimit: (limit: number) => void;
  resource: Resource<Rule[]>;
  reload: () => void;
  lifecycle: (rule: Rule, action: 'pause' | 'resume' | 'cancel') => ActionSpec;
}

export function useAutoInvestRules(): AutoInvestRulesRead {
  const api = useApi();
  const [limit, setLimit] = usePageLimit();
  const { resource, reload } = useBankRecord(BANK_AUTO_INVEST_LIST, { limit });
  function lifecycle(rule: Rule, action: 'pause' | 'resume' | 'cancel'): ActionSpec {
    const facts: [string, string][] = [
      [t('reference'), rule.id],
      [t('from'), t('mainAsset', { asset: rule.assetId })],
    ];
    if (rule.kind === 'dca') {
      facts.push([t('buy'), rule.buyAssetId ?? t('buyUnavailable')], [t('budget'), funds(rule.amount, rule.assetId)]);
      facts.push([t('cadence'), rule.cadence ?? t('eventDriven')]);
    } else facts.push([rule.kind === 'threshold_sweep' ? t('sweep') : t('roundup'), funds(rule.threshold ?? rule.amount, rule.assetId)]);
    facts.push([t('nextRun'), date(rule.nextRunAt)]);
    return {
      title: t(action === 'pause' ? 'pauseTitle' : action === 'resume' ? 'resumeTitle' : 'cancelTitle'),
      procedure: `autoInvest.${action}`,
      facts,
      notes: [t(action === 'pause' ? 'pauseNote' : action === 'resume' ? 'pausedNote' : 'cancelNote')],
      input: () => ({ ruleId: rule.id }),
      verifyOutcome:
        action === 'cancel'
          ? undefined
          : (data) => {
              const returned = data as z.infer<typeof ruleSchema>;
              const sameQuantity = (a: string | null, b: string | null) =>
                a === null || b === null ? a === b : parseAmount(a) === parseAmount(b);
              return (
                returned.kind === rule.kind &&
                returned.assetId === rule.assetId &&
                returned.buyAssetId === rule.buyAssetId &&
                returned.targetPoolId === rule.targetPoolId &&
                (returned.targetSpaceId ?? null) === (rule.targetSpaceId ?? null) &&
                returned.cadence === rule.cadence &&
                returned.createdAt === rule.createdAt &&
                sameQuantity(returned.amount, rule.amount) &&
                sameQuantity(returned.threshold, rule.threshold)
              );
            },
      unit: rule.assetId,
      preflight: async () => {
        const latest = await api.call(BANK_AUTO_INVEST_LIST, { limit });
        if (!latest.ok) return readRefusal(t('rulesSubject'));
        const current = latest.data.find((row) => row.id === rule.id);
        // Missing from this bounded read cannot establish cancellation or an outcome.
        if (!current || JSON.stringify(current) !== JSON.stringify(rule)) return refusal(t('contextChanged'));
        if (action === 'resume') {
          const policy = await api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']);
          if (!policy.ok) return readRefusal(t('policySubject'));
          if (!policy.data.enabled || (rule.kind === 'dca' && !policy.data.convertWired)) return refusal(t('contextChanged'));
        }
        return { ok: true, data: null };
      },
    };
  }
  return { limit, setLimit, resource, reload, lifecycle };
}

/** The bank's automatic investing policy: whether a repeat buy can be set up at all. */
export function useAutoInvestPolicy() {
  return useBankRead('autoInvest.policy', undefined);
}

/** The review that sets up a repeat buy of `asset` paid from `spendAsset`, checked again against the policy and balances before it is sent. */
export function repeatBuySetup(api: ApiClient, asset: string, spendAsset: string): ActionSpec {
  return {
    title: t('title', { asset }),
    procedure: 'autoInvest.createDca',
    fields: [positiveMoney(spendAsset, 'amount', t('budget')), cadenceField, startsField],
    facts: [
      [t('buy'), asset],
      [t('from'), t('mainAsset', { asset: spendAsset })],
    ],
    notes: [t('executionNote'), t('refusalNote')],
    submit: t('create'),
    unit: spendAsset,
    input: (values) => ({
      spendAssetId: spendAsset,
      buyAssetId: asset,
      amount: values.amount,
      cadence: values.cadence,
      startsAt: iso(values.startsAt!),
    }),
    preflight: async (input) => {
      if (!spendAsset || spendAsset === asset) return refusal(t('contextChanged'));
      if (typeof input.startsAt !== 'string' || Date.parse(input.startsAt) <= Date.now()) return refusal(t('startExpired'));
      const [policy, fresh] = await Promise.all([
        api.query('bank', 'autoInvest.policy', undefined, bankReads['autoInvest.policy']),
        createMoneyClient(api).balances(),
      ]);
      if (!policy.ok) return readRefusal(t('policySubject'));
      if (!fresh.ok) return readRefusal(t('sourceSubject'));
      if (!policy.data.enabled || !policy.data.convertWired || !Object.hasOwn(fresh.data.balances, spendAsset))
        return refusal(t('contextChanged'));
      if (Date.parse(input.startsAt) <= Date.now()) return refusal(t('startExpired'));
      // Scheduling reserves nothing. A zero balance does not prevent future funding.
      return { ok: true, data: null };
    },
  };
}
