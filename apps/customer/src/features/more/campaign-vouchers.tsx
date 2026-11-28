import { useMemo, useState, type FormEvent } from 'react';
import { type MyVoucher, type VoucherValidation } from '@intafaced/contracts/campaigns-catalogue';
import {
  CAMPAIGNS_VOUCHERS_CLAIM,
  CAMPAIGNS_VOUCHERS_MINE,
  CAMPAIGNS_VOUCHERS_REDEEM,
  CAMPAIGNS_VOUCHERS_VALIDATE,
} from '@intafaced/contracts/campaigns-procedures';
import { useApi } from '../session';
import { useResource } from '../../shared/resource';
import type { ApiResult } from '../../shared/api';
import { Button, Field } from '@intafaced/ui/lit';
import { FailureBox, LoadingLine, RecordTable } from '../../shared/record/record-parts';
import { EmptyNote } from './volt-parts';
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
  'campaigns.voucher_not_cash',
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
      <p role="status" className="lt-hint" data-testid="voucher-refusal" data-code={code}>
        {t(code)}
      </p>
    );
  }
  if (result.reason === 'unreachable' || result.reason === 'uncertain' || result.reason === 'aborted') {
    return (
      <p role="status" className="lt-hint" data-testid="voucher-lost">
        {t('lost')}
      </p>
    );
  }
  return <FailureBox result={result} />;
}

export function MyVouchers() {
  const api = useApi();
  const { t } = campaignVouchersCopy.useCopy();
  const when = useWhen();
  const delayOf = (seconds: number) => delayText(t, seconds);
  const wallet = useResource((signal) => api.call(CAMPAIGNS_VOUCHERS_MINE, {}, { signal }), 'campaign-vouchers');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'check' | 'claim' | null>(null);
  const [refusal, setRefusal] = useState<Failed | null>(null);
  const [checked, setChecked] = useState<VoucherValidation | null>(null);
  // Each row's last refusal, by voucher: the wallet is read again after every answer, so it outlives the rows' remount.
  const [rowRefusals, setRowRefusals] = useState<Record<string, Failed | null>>({});

  const check = async () => {
    setBusy('check');
    const result = await api.call(CAMPAIGNS_VOUCHERS_VALIDATE, { code: code.trim() });
    setBusy(null);
    setChecked(result.ok ? result.data : null);
    setRefusal(result.ok ? null : result);
  };
  const claim = async () => {
    setBusy('claim');
    const result = await api.call(CAMPAIGNS_VOUCHERS_CLAIM, { code: code.trim() });
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
    <section>
      <h2>{t('title')}</h2>
      <form aria-label={t('formLabel')} onSubmit={onSubmit}>
        <Field label={t('code')} value={code} maxLength={32} autoComplete="off" onChange={(event) => setCode(event.target.value)} />
        <div className="lt-actions">
          <Button type="submit" tone="quiet" disabled={busy !== null || !code.trim()}>
            {busy === 'check' ? t('checking') : t('check')}
          </Button>
          <Button tone="primary" disabled={busy !== null || !code.trim()} onClick={() => void claim()}>
            {busy === 'claim' ? t('claiming') : t('claim')}
          </Button>
        </div>
        <p className="lt-hint">{t('formNote')}</p>
      </form>
      {checked ? (
        <p role="status" data-testid="voucher-validation">
          {checked.feeRebate
            ? t('validationFeeRebate', {
                pct: percentOfFee(checked.feeRebate.rebateBps),
                amount: checked.face.amount,
                asset: checked.face.asset,
                delay: delayOf(checked.feeRebate.delaySeconds),
                campaign: checked.campaignName,
                claimBy: when(checked.claimBy),
                useBy: when(checked.useBy),
              })
            : checked.feeSaver
              ? t('validationFeeSaver', {
                  pct: percentOfFee(checked.feeSaver.discountBps),
                  orders: checked.feeSaver.orders,
                  campaign: checked.campaignName,
                  claimBy: when(checked.claimBy),
                  useBy: when(checked.useBy),
                })
              : t('validation', {
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
          <LoadingLine label={t('loading')} />
        ) : wallet.resource.status === 'failed' ? (
          <FailureBox result={wallet.resource.failure} retry={wallet.reload} />
        ) : wallet.resource.data.vouchers.length === 0 ? (
          <div data-testid="vouchers-empty">
            <EmptyNote title={t('none')}>{t('noneBody')}</EmptyNote>
          </div>
        ) : (
          <RecordTable
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
          </RecordTable>
        )}
      </div>
      <p className="lt-hint">{t('redeemNote')}</p>
    </section>
  );
}

/** A discount in basis points of the fee as a percent of that fee: 5000 is "50". */
const percentOfFee = (bps: number): string => String(bps / 100);

type Copy = ReturnType<typeof campaignVouchersCopy.useCopy>['t'];
/** A fee rebate's delay in the largest whole unit it fills. */
function delayText(t: Copy, seconds: number): string {
  if (seconds === 0) return t('delayNone');
  if (seconds % 3600 === 0) return t('delayHours', { n: seconds / 3600 });
  if (seconds % 60 === 0) return t('delayMinutes', { n: seconds / 60 });
  return t('delaySeconds', { n: seconds });
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
  const delayOf = (seconds: number) => delayText(t, seconds);
  // A fee-saver is never redeemed: it is taken on an order when our builder fee is priced. A fee rebate pays only what
  // its fills accrue.
  const open = v.kind === 'cash' && (v.state === 'claimed' || v.state === 'partially_used') && v.remaining !== '0';
  const redeem = async () => {
    setBusy(true);
    const result = await api.call(CAMPAIGNS_VOUCHERS_REDEEM, {
      voucherId: v.id,
      amount: amount.trim(),
      sequence: v.redemptions.length + 1,
    });
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
        {v.feeSaver ? (
          <>
            <span data-testid="voucher-kind" data-kind={v.kind}>
              {t('kind_fee_saver')}
            </span>{' '}
            <span data-testid="voucher-does">
              {t('feeSaverDoes', { pct: percentOfFee(v.feeSaver.discountBps), orders: v.feeSaver.orders })}
            </span>{' '}
            <span data-testid="voucher-remaining">{t('ordersLeft', { remaining: v.remaining, orders: v.feeSaver.orders })}</span>
            {v.feeSaver.uses.length > 0 ? (
              <ul aria-label={t('feeSaverUses')} data-testid="voucher-uses">
                {v.feeSaver.uses.map((u) => (
                  <li key={u.sequence} data-order-key={u.orderKey}>
                    {t('feeSaverUse', { sequence: u.sequence, when: when(u.at) })}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : v.feeRebate ? (
          <>
            <span data-testid="voucher-kind" data-kind={v.kind}>
              {t('kind_fee_rebate')}
            </span>{' '}
            <span data-testid="voucher-does">
              {t('feeRebateDoes', {
                pct: percentOfFee(v.feeRebate.rebateBps),
                delay: delayOf(v.feeRebate.delaySeconds),
                face: v.face.amount,
                asset: v.face.asset,
              })}
            </span>{' '}
            <span data-testid="voucher-remaining">{t('left', { remaining: v.remaining, face: v.face.amount, asset: v.face.asset })}</span>
            {v.feeRebate.accruals.length > 0 ? (
              <ul aria-label={t('feeRebateAccruals')} data-testid="voucher-accruals">
                {v.feeRebate.accruals.map((a) => (
                  <li
                    key={a.sequence}
                    data-testid="voucher-accrual"
                    data-sequence={a.sequence}
                    data-fill={a.fillId}
                    data-amount={a.amount}
                    data-builder-fee={a.builderFee}
                  >
                    {t('feeRebateAccrual', {
                      amount: a.amount,
                      asset: v.face.asset,
                      fee: a.builderFee,
                      when: when(a.filledAt),
                      payable: when(a.payableAt),
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <>
            <span data-testid="voucher-kind" data-kind={v.kind}>
              {t('kind_cash')}
            </span>{' '}
            <span data-testid="voucher-remaining">{t('left', { remaining: v.remaining, face: v.face.amount, asset: v.face.asset })}</span>
          </>
        )}
        {v.redemptions.length > 0 ? (
          <ul aria-label={t('redemptions')} data-testid="voucher-redemptions">
            {v.redemptions.map((r) => (
              <li key={r.sequence} data-reward-key={r.reward.rewardKey} data-state={r.reward.state}>
                {t('redemption', { amount: r.amount, asset: v.face.asset, state: t(`reward_${r.reward.state}`) })}
                {r.reward.payout ? (
                  <>
                    {' '}
                    {/* The chain's own record of the payment: it left INTAFACED's wallet for the connected one, never a balance.
                        The wallet and the hash have no spaces: they break anywhere, so the table stays inside the room. */}
                    <span className="lt-wrap" data-testid="voucher-paid-to" data-wallet={r.reward.payout.toWallet}>
                      {t('paidTo', { wallet: r.reward.payout.toWallet })}
                    </span>{' '}
                    <a
                      className="lt-link lt-wrap"
                      data-testid="voucher-chain-tx"
                      data-tx={r.reward.payout.chainTx}
                      href={`/chain/tx/${encodeURIComponent(r.reward.payout.chainTx)}`}
                      lang="zxx"
                    >
                      {t('chainTx', { tx: r.reward.payout.chainTx })}
                    </a>
                  </>
                ) : null}
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
            <Button tone="primary" disabled={busy || !amount.trim()} onClick={() => void redeem()}>
              {busy ? t('redeeming') : t('redeem')}
            </Button>
          </>
        ) : null}
        {refusal ? <Refusal result={refusal} /> : null}
      </td>
    </tr>
  );
}
