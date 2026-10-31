import { useMemo, useState, type FormEvent } from 'react';
import {
  myVoucherSchema,
  myVouchersSchema,
  voucherRedeemResultSchema,
  voucherValidationSchema,
  type MyVoucher,
  type VoucherValidation,
} from '@intafaced/contracts/campaigns-catalogue';
import { useApi } from '../session/session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, DataTable, EmptyState, Failure, Field, Loading, Panel } from '../../shared/ui';
import { campaignVouchersCopy } from './campaign-vouchers-copy';

/**
 * My vouchers at /campaigns/mine (J-campaigns-08, CM-vouchers-coupons-01): check a code, claim it, and redeem part or all
 * of what is left. Everything shown is read from svc-campaigns; after any answer, or none, the wallet is read again and
 * nothing is sent twice. A code that cannot be claimed always reads the same, whoever holds it.
 */

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

const CODES = [
  'campaigns.voucher_invalid',
  'campaigns.voucher_window_unset',
  'campaigns.voucher_expired',
  'campaigns.voucher_amount_invalid',
  'campaigns.voucher_exceeds_remaining',
  'campaigns.voucher_sequence_invalid',
  'campaigns.budget_exhausted',
  'campaigns.budget_asset_mismatch',
  'campaigns.reward_saga_unwired',
  'campaigns.participant_unread',
  'campaigns.not_eligible',
  'campaigns.region_blocked',
  'campaigns.timezone_unset',
  'campaigns.per_customer_limit_unset',
  'campaigns.customer_limit_reached',
  'campaigns.redemption_limit_reached',
] as const;
type Code = (typeof CODES)[number];
const codeOf = (code: string | undefined): Code | null => (CODES as readonly string[]).find((c) => c === code) as Code | null;

function useWhen() {
  const { renderedLocale } = campaignVouchersCopy.useCopy();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(renderedLocale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });
    return (isoTime: string) => format.format(new Date(isoTime));
  }, [renderedLocale]);
}

/** A refusal in this room's words, a lost answer as such, anything else through the shared Failure. */
function Refusal({ result }: { result: Failed }) {
  const { t } = campaignVouchersCopy.useCopy();
  const code = codeOf(result.code);
  if (code) {
    return (
      <p role="status" className="muted" data-testid="voucher-refusal" data-code={code}>
        {t(code)}
      </p>
    );
  }
  if (result.reason === 'unreachable' || result.reason === 'uncertain' || result.reason === 'aborted') {
    return (
      <p role="status" className="muted" data-testid="voucher-lost">
        {t('lost')}
      </p>
    );
  }
  return <Failure result={result} />;
}

export function MyVouchers() {
  const api = useApi();
  const { t } = campaignVouchersCopy.useCopy();
  const when = useWhen();
  const wallet = useResource((signal) => api.query('campaigns', 'vouchers.mine', {}, myVouchersSchema, { signal }), 'campaign-vouchers');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'check' | 'claim' | null>(null);
  const [refusal, setRefusal] = useState<Failed | null>(null);
  const [checked, setChecked] = useState<VoucherValidation | null>(null);
  // Each row's last refusal, by voucher: the wallet is read again after every answer, so it outlives the rows' remount.
  const [rowRefusals, setRowRefusals] = useState<Record<string, Failed | null>>({});

  const check = async () => {
    setBusy('check');
    const result = await api.query('campaigns', 'vouchers.validate', { code: code.trim() }, voucherValidationSchema);
    setBusy(null);
    setChecked(result.ok ? result.data : null);
    setRefusal(result.ok ? null : result);
  };
  const claim = async () => {
    setBusy('claim');
    const result = await api.mutate('campaigns', 'vouchers.claim', { code: code.trim() }, myVoucherSchema);
    setBusy(null);
    setChecked(null);
    setRefusal(result.ok ? null : result);
    if (result.ok) setCode('');
    // Whatever came back, or nothing, the wallet is read again: a lost answer never sends a second claim.
    wallet.reload();
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void check();
  };

  return (
    <Panel title={t('title')}>
      <form aria-label={t('formLabel')} onSubmit={onSubmit}>
        <Field label={t('code')} value={code} maxLength={32} autoComplete="off" onChange={(event) => setCode(event.target.value)} />
        <div className="depth-card-actions">
          <Button type="submit" variant="ghost" disabled={busy !== null || !code.trim()}>
            {busy === 'check' ? t('checking') : t('check')}
          </Button>
          <Button disabled={busy !== null || !code.trim()} onClick={() => void claim()}>
            {busy === 'claim' ? t('claiming') : t('claim')}
          </Button>
        </div>
        <p className="muted">{t('formNote')}</p>
      </form>
      {checked ? (
        <p role="status" data-testid="voucher-validation">
          {t('validation', {
            amount: checked.face.amount,
            asset: checked.face.asset,
            campaign: checked.campaignName,
            claimBy: when(checked.claimBy),
            useBy: when(checked.useBy),
          })}
        </p>
      ) : null}
      {refusal ? <Refusal result={refusal} /> : null}
      <div data-testid="my-vouchers" data-state={wallet.resource.status}>
        {wallet.resource.status === 'loading' ? (
          <Loading label={t('loading')} />
        ) : wallet.resource.status === 'failed' ? (
          <Failure result={wallet.resource.failure} retry={wallet.reload} />
        ) : wallet.resource.data.vouchers.length === 0 ? (
          <div data-testid="vouchers-empty">
            <EmptyState title={t('none')}>{t('noneBody')}</EmptyState>
          </div>
        ) : (
          <DataTable
            label={t('listLabel')}
            headers={[t('colCode'), t('colCampaign'), t('colState'), t('colLeft'), t('colUseBy'), t('colRedeem')]}
          >
            {wallet.resource.data.vouchers.map((v) => (
              <VoucherRow
                key={v.id}
                voucher={v}
                when={when}
                refusal={rowRefusals[v.id] ?? null}
                answered={(result) => {
                  setRowRefusals((all) => ({ ...all, [v.id]: result }));
                  // The wallet is read again either way, so the next redemption is numbered from what is stored.
                  wallet.reload();
                }}
              />
            ))}
          </DataTable>
        )}
      </div>
      <p className="muted">{t('redeemNote')}</p>
    </Panel>
  );
}

function VoucherRow({
  voucher: v,
  when,
  refusal,
  answered,
}: {
  voucher: MyVoucher;
  when: (iso: string) => string;
  refusal: Failed | null;
  answered: (refusal: Failed | null) => void;
}) {
  const api = useApi();
  const { t } = campaignVouchersCopy.useCopy();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const open = (v.state === 'claimed' || v.state === 'partially_used') && v.remaining !== '0';
  const redeem = async () => {
    setBusy(true);
    const result = await api.mutate(
      'campaigns',
      'vouchers.redeem',
      { voucherId: v.id, amount: amount.trim(), sequence: v.redemptions.length + 1 },
      voucherRedeemResultSchema,
    );
    setBusy(false);
    if (result.ok) setAmount('');
    answered(result.ok ? null : result);
  };
  return (
    <tr data-testid="my-voucher" data-voucher-id={v.id} data-state={v.state}>
      <th scope="row" lang="zxx">
        {v.code}
      </th>
      <td>{v.campaignName}</td>
      <td data-testid="voucher-state">{t(`state_${v.state}`)}</td>
      <td>
        <span data-testid="voucher-remaining">{t('left', { remaining: v.remaining, face: v.face.amount, asset: v.face.asset })}</span>
        {v.redemptions.length > 0 ? (
          <ul aria-label={t('redemptions')} data-testid="voucher-redemptions">
            {v.redemptions.map((r) => (
              <li key={r.sequence} data-reward-key={r.reward.rewardKey} data-state={r.reward.state}>
                {t('redemption', { amount: r.amount, asset: v.face.asset, state: t(`reward_${r.reward.state}`) })}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
      <td data-testid="voucher-use-by">
        {v.expiredAt ? t('expiredAt', { when: when(v.expiredAt) }) : t('useBy', { when: when(v.useBy) })}
      </td>
      <td>
        {open ? (
          <>
            <Field
              label={t('amount')}
              value={amount}
              inputMode="decimal"
              maxLength={40}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Button disabled={busy || !amount.trim()} onClick={() => void redeem()}>
              {busy ? t('redeeming') : t('redeem')}
            </Button>
          </>
        ) : null}
        {refusal ? <Refusal result={refusal} /> : null}
      </td>
    </tr>
  );
}
