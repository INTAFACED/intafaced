// volt-room: /bank/loans/overdraft
// volt-room: /bank/loans/personal
// volt-room: /bank/loans/schedule
// volt-room: /bank/cards/credit-card
// volt-room: /bank/cards/credit
// volt-room: /bank/business/loan
import { useState, type ReactNode } from 'react';
import { Button, Field, Segmented } from '@intafaced/ui/lit';
import { FlowTemplate, KeyValue, RefusalBox, Table, type KeyValueRow, type Notice, type RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import type { ApiClient, ApiResult, AppProcedure } from '../../../shared/api';
import { useSession } from '../../session';
import {
  BANK_CREDIT_PREVIEWS_ACT,
  CREDIT_PREVIEW_ACTIONS,
  BANK_CREDIT_PREVIEWS_OVERVIEW,
  BANK_CREDIT_PREVIEWS_REVOLVING,
  BANK_CREDIT_PREVIEWS_SCHEDULE,
  BANK_CREDIT_CARD_APPLICATION,
  BANK_CREDIT_CARD_PREVIEW,
  BANK_LOANS_CHANGE_REPAYMENT_DATE,
  BANK_LOANS_MISSED_PAYMENT_POLICY,
  type CreditCardPreviewView,
  type LoanMissedPaymentPolicyView,
  type CreditPreviewActInput,
  type CreditPreviewOverview,
  type CreditPreviewRevolving,
  type CreditPreviewSchedule,
} from '@intafaced/contracts/bank-credit-preview-procedures';
import { creditPreviewCopy } from './credit-preview-copy';

/**
 * The credit previews (J-bank-12), each at its own route on the flow template:
 *   /bank/loans/overdraft and its credit bureau panel, /bank/loans/personal, /bank/business/loan (BK-loan-08),
 *   /bank/loans/schedule (BK-loan-09), /bank/cards/credit-card (BK-loan-10), /bank/cards/credit (BK-cops-09).
 * The kit's notice says "Preview · sample data" on every one. Every figure is a TEST fixture the bank serves
 * (`bank.creditPreviews.*`, `bank.creditCard.preview`), shown as marked sample data with a text alternative, never a constant here.
 * Local choices (a term, a name, a date) stay on the page; every engine action is sent to the bank, which refuses it
 * with the typed Preview refusal (`preview.engine_not_built`, HTTP 412). Nothing is stored and no money moves.
 */

type Copy = ReturnType<typeof creditPreviewCopy.useCopy>;
type Failed = Extract<ApiResult<unknown>, { ok: false }>;
const PREVIEW_CODE = 'preview.engine_not_built';

/** Dynamic keys (an engine, an action, a section) read through one door. */
const tk = (c: Copy, key: string, vars?: Record<string, string | number>) => (c.t as (k: string, v?: unknown) => string)(key, vars);

/** One preview read, by its record. */
function useBankRecord<R extends AppProcedure>(record: R) {
  const { api, userId } = useSession();
  return useResource(async (signal) => {
    if (!userId) return { ok: false as const, reason: 'unauthorized' as const, message: '' };
    return api.call(record, undefined as never, { signal });
  }, `${userId}:${record.name}`);
}

interface Refused {
  readonly action: string;
  readonly engine: string | null;
  readonly failed: Failed;
}

/** Sends one engine action; the bank always refuses it. */
function useEngineAction() {
  const { api } = useSession();
  const [refused, setRefused] = useState<Refused | null>(null);
  const [busy, setBusy] = useState(false);
  /** `send` makes the one call, by its record. */
  async function act(action: string, send: (client: ApiClient) => Promise<ApiResult<unknown>>) {
    setBusy(true);
    const res = await send(api);
    setBusy(false);
    if (res.ok) return;
    // The refusal's message is `preview.engine_not_built — <engine>:<action>`; the engine names what is missing.
    const engine = /preview\.engine_not_built — ([a-z_.]+):/.exec(res.message ?? '')?.[1] ?? null;
    setRefused({ action, engine, failed: res });
  }
  return { refused, busy, act };
}

function PreviewRefusal({ refused }: { refused: Refused | null }) {
  const c = creditPreviewCopy.useCopy();
  if (!refused) return null;
  const isPreview = Boolean(refused.engine) || refused.failed.code === PREVIEW_CODE;
  const engineKey = refused.engine ? `engine_${refused.engine.replace(/^bank\./, '')}` : null;
  return (
    <div
      data-testid="preview-refusal"
      role="alert"
      data-code={isPreview ? PREVIEW_CODE : ''}
      data-kind={isPreview ? 'preview' : ''}
      data-engine={refused.engine ?? ''}
    >
      <RefusalBox
        refusal={{
          variant: 'refused',
          title: tk(c, 'refusalTitle', { action: tk(c, `action_${refused.action}`) }),
          body: isPreview && engineKey ? tk(c, 'refusalBody', { engine: tk(c, engineKey) }) : c.t('refusalOther'),
          reference: refused.failed.code ?? PREVIEW_CODE,
        }}
      />
    </div>
  );
}

/**
 * A panel that would show an engine's output: TEST sample figures, named as sample data for a screen reader too. The kit
 * draws no blur on the content layer, so the panel is marked as sample data, never drawn as a real figure.
 */
function EnginePanel({ name, children }: { name: string; children: ReactNode }) {
  const c = creditPreviewCopy.useCopy();
  return (
    <div data-testid="preview-engine" data-sample="true" role="group" aria-label={tk(c, 'sampleData', { name })}>
      {children}
    </div>
  );
}

function ActionButtons<A extends string>({ actions, busy, onAct }: { actions: readonly A[]; busy: boolean; onAct: (action: A) => void }) {
  const c = creditPreviewCopy.useCopy();
  return (
    <div>
      {actions.map((a, i) => (
        <Button key={a} tone={i === actions.length - 1 ? 'primary' : 'secondary'} disabled={busy} onClick={() => onAct(a)}>
          {tk(c, `action_${a}`)}
        </Button>
      ))}
    </div>
  );
}

function usePreviewNotice(c: Copy): Notice[] {
  return [{ id: 'preview', refusal: { variant: 'parked', title: c.t('label'), body: c.t('noticeBody') } }];
}

/** The room's state from its read: signed out and a failed read are said in words; never an empty page. */
function roomState(c: Copy, resource: { status: string; failure?: Failed }, path: string): RoomState {
  if (resource.status === 'loading') return { kind: 'loading' };
  if (resource.status === 'failed') {
    const failed = resource.failure;
    if (failed?.reason === 'unauthorized')
      return {
        kind: 'refused',
        refusal: {
          variant: 'refused',
          title: c.t('signedOutTitle'),
          body: c.t('signedOutBody'),
          action: { label: c.t('signIn'), href: `/login?redirect=${encodeURIComponent(path)}` },
        },
      };
    return {
      kind: 'refused',
      refusal: { variant: 'unreachable', title: c.t('readFailedTitle'), body: failed?.message ?? '', reference: failed?.code },
    };
  }
  return { kind: 'ready' };
}

const money = (c: Copy, figure: string, currency: string) => tk(c, 'testFigure', { figure: `${figure} ${currency}` });
const pct = (c: Copy, rate: string) => tk(c, 'percent', { rate });

function dataOf<T>(r: { status: string; data?: T }): T | null {
  return r.status === 'ready' ? (r.data as T) : null;
}

// ---- /bank/loans/overdraft (BK-loan-08: overdraft and credit bureau) ---------------------------------------------

export function OverdraftPreviewRoom() {
  const c = creditPreviewCopy.useCopy();
  const { resource } = useBankRecord(BANK_CREDIT_PREVIEWS_OVERVIEW);
  const engine = useEngineAction();
  const [limit, setLimit] = useState<string | null>(null);
  const view = dataOf<CreditPreviewOverview>(resource);
  const od = view?.overdraft;
  const chosen = limit ?? od?.limits[0] ?? '';
  const cost = od?.monthlyCost.find((r) => r.limit === chosen);
  const act = (input: CreditPreviewActInput) => void engine.act(input.action, (client) => client.call(BANK_CREDIT_PREVIEWS_ACT, input));
  return (
    <FlowTemplate
      title={c.t('overdraftTitle')}
      description={c.t('overdraftDescription')}
      state={roomState(c, resource as never, '/bank/loans/overdraft')}
      notices={usePreviewNotice(c)}
      step={
        view && od ? (
          <div data-testid="credit-preview" data-room="overdraft">
            <Segmented
              label={c.t('overdraftLimit')}
              value={chosen}
              onChange={setLimit}
              options={od.limits.map((l) => ({ value: l, label: money(c, l, view.currency) }))}
            />
            <section aria-label={c.t('bureauTitle')}>
              <h2>{c.t('bureauTitle')}</h2>
              <EnginePanel name={c.t('bureauTitle')}>
                <ul>
                  {view.bureau.rows.map((r) => (
                    <li key={r.item}>
                      {tk(c, `bureau_${r.item}`)} {c.t('test')}
                    </li>
                  ))}
                </ul>
              </EnginePanel>
              <ActionButtons actions={['view_file']} busy={engine.busy} onAct={(action) => act({ product: 'credit_bureau', action })} />
            </section>
          </div>
        ) : null
      }
      summary={
        view && od ? (
          <EnginePanel name={c.t('overdraftTitle')}>
            <KeyValue
              label={c.t('overdraftTitle')}
              rows={[
                { label: c.t('overdraftLimit'), value: money(c, chosen, view.currency) },
                { label: c.t('overdraftRate'), value: pct(c, od.rate) },
                { label: c.t('overdraftMonthly'), value: cost ? money(c, cost.cost, view.currency) : c.t('notSet'), unset: !cost },
                { label: c.t('overdraftWindow'), value: tk(c, 'months', { n: od.repaymentWindowMonths }) },
              ]}
            />
          </EnginePanel>
        ) : null
      }
      actions={
        view ? (
          <div>
            <PreviewRefusal refused={engine.refused} />
            <ActionButtons
              actions={['check_eligibility', 'change_limit', 'cancel', 'apply'] as const}
              busy={engine.busy}
              onAct={(action) => act({ product: 'overdraft', action })}
            />
          </div>
        ) : null
      }
    />
  );
}

// ---- /bank/loans/personal (BK-loan-08: unsecured personal loan) ---------------------------------------------------

export function PersonalLoanPreviewRoom() {
  const c = creditPreviewCopy.useCopy();
  const { resource } = useBankRecord(BANK_CREDIT_PREVIEWS_OVERVIEW);
  const engine = useEngineAction();
  const [term, setTerm] = useState<number | null>(null);
  const [name, setName] = useState('');
  const view = dataOf<CreditPreviewOverview>(resource);
  const pl = view?.personalLoan;
  const chosen = pl?.terms.find((t) => t.termMonths === term) ?? pl?.terms[0];
  const act = (action: (typeof CREDIT_PREVIEW_ACTIONS)['personal_loan'][number]) =>
    void engine.act(action, (client) => client.call(BANK_CREDIT_PREVIEWS_ACT, { product: 'personal_loan', action }));
  return (
    <FlowTemplate
      title={c.t('personalTitle')}
      description={c.t('personalDescription')}
      state={roomState(c, resource as never, '/bank/loans/personal')}
      notices={usePreviewNotice(c)}
      step={
        view && pl && chosen ? (
          <div data-testid="credit-preview" data-room="personal_loan">
            <Field
              label={c.t('loanName')}
              hint={c.t('loanNameHint')}
              name="loanName"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
            />
            <Segmented
              label={c.t('term')}
              value={String(chosen.termMonths)}
              onChange={(v) => setTerm(Number(v))}
              options={pl.terms.map((t) => ({ value: String(t.termMonths), label: tk(c, 'termMonths', { n: t.termMonths }) }))}
            />
          </div>
        ) : null
      }
      summary={
        view && pl && chosen ? (
          <EnginePanel name={c.t('calculator')}>
            <KeyValue
              label={name.trim() || c.t('calculator')}
              rows={[
                { label: c.t('amount'), value: money(c, pl.amount, view.currency) },
                { label: c.t('term'), value: tk(c, 'termMonths', { n: chosen.termMonths }) },
                { label: c.t('rate'), value: pct(c, pl.rate) },
                { label: c.t('monthly'), value: money(c, chosen.monthly, view.currency) },
                { label: c.t('totalInterest'), value: money(c, chosen.totalInterest, view.currency), total: true },
              ]}
            />
          </EnginePanel>
        ) : null
      }
      actions={
        view ? (
          <div>
            <PreviewRefusal refused={engine.refused} />
            <ActionButtons actions={CREDIT_PREVIEW_ACTIONS.personal_loan} busy={engine.busy} onAct={act} />
          </div>
        ) : null
      }
    />
  );
}

// ---- /bank/business/loan (BK-loan-08: business term loan) ---------------------------------------------------------

export function BusinessLoanPreviewRoom() {
  const c = creditPreviewCopy.useCopy();
  const { resource } = useBankRecord(BANK_CREDIT_PREVIEWS_OVERVIEW);
  const engine = useEngineAction();
  const [weeks, setWeeks] = useState<number | null>(null);
  const view = dataOf<CreditPreviewOverview>(resource);
  const bl = view?.businessTermLoan;
  const chosen = bl?.terms.find((t) => t.weeks === weeks) ?? bl?.terms[0];
  const act = (action: (typeof CREDIT_PREVIEW_ACTIONS)['business_term_loan'][number]) =>
    void engine.act(action, (client) => client.call(BANK_CREDIT_PREVIEWS_ACT, { product: 'business_term_loan', action }));
  return (
    <FlowTemplate
      title={c.t('businessTitle')}
      description={c.t('businessDescription')}
      state={roomState(c, resource as never, '/bank/business/loan')}
      notices={usePreviewNotice(c)}
      step={
        view && bl && chosen ? (
          <div data-testid="credit-preview" data-room="business_term_loan">
            <Segmented
              label={c.t('term')}
              value={String(chosen.weeks)}
              onChange={(v) => setWeeks(Number(v))}
              options={bl.terms.map((t) => ({ value: String(t.weeks), label: tk(c, 'weeks', { n: t.weeks }) }))}
            />
          </div>
        ) : null
      }
      summary={
        view && bl && chosen ? (
          <EnginePanel name={c.t('businessTitle')}>
            <KeyValue
              label={c.t('businessTitle')}
              rows={[
                { label: c.t('amount'), value: money(c, bl.amount, view.currency) },
                { label: c.t('flatFee'), value: pct(c, bl.flatFee) },
                { label: c.t('fee'), value: money(c, chosen.fee, view.currency) },
                { label: c.t('weekly'), value: money(c, chosen.weekly, view.currency), total: true },
              ]}
            />
          </EnginePanel>
        ) : null
      }
      actions={
        view ? (
          <div>
            <PreviewRefusal refused={engine.refused} />
            <ActionButtons actions={CREDIT_PREVIEW_ACTIONS.business_term_loan} busy={engine.busy} onAct={act} />
          </div>
        ) : null
      }
    />
  );
}

// ---- /bank/loans/schedule (BK-loan-09: unsecured loan servicing) --------------------------------------------------

export function LoanSchedulePreviewRoom() {
  const c = creditPreviewCopy.useCopy();
  const { resource } = useBankRecord(BANK_CREDIT_PREVIEWS_SCHEDULE);
  const policy = useBankRecord(BANK_LOANS_MISSED_PAYMENT_POLICY);
  const engine = useEngineAction();
  const [date, setDate] = useState('');
  const view = dataOf<CreditPreviewSchedule>(resource);
  const p = dataOf<LoanMissedPaymentPolicyView>(policy.resource);
  const policyRows: KeyValueRow[] =
    p?.status === 'set'
      ? [
          { label: c.t('graceDays'), value: String(p.graceDays) },
          { label: c.t('catchUpDays'), value: String(p.catchUpDays) },
          { label: c.t('lateFee'), value: p.lateFee },
        ]
      : [
          { label: c.t('graceDays'), value: c.t('notSet'), unset: true },
          { label: c.t('catchUpDays'), value: c.t('notSet'), unset: true },
          { label: c.t('lateFee'), value: c.t('notSet'), unset: true },
        ];
  return (
    <FlowTemplate
      title={c.t('scheduleTitle')}
      description={c.t('scheduleDescription')}
      state={roomState(c, resource as never, '/bank/loans/schedule')}
      notices={usePreviewNotice(c)}
      step={
        view ? (
          <div data-testid="credit-preview" data-room="loan_schedule">
            <EnginePanel name={c.t('schedule')}>
              <Table
                caption={c.t('schedule')}
                columns={[
                  { key: 'n', label: c.t('repayment'), cell: (r) => tk(c, 'repaymentN', { n: r.n, total: view.termMonths }) },
                  { key: 'amount', label: c.t('amount'), align: 'end', cell: (r) => money(c, r.amount, view.currency) },
                ]}
                rows={view.rows}
                rowKey={(r) => String(r.n)}
              />
            </EnginePanel>
            <Field label={c.t('newDate')} type="date" name="repaymentDate" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        ) : null
      }
      summary={
        view ? (
          <section aria-label={c.t('missedPolicy')} data-testid="missed-payment-policy" data-status={p?.status ?? policy.resource.status}>
            <h2>{c.t('missedPolicy')}</h2>
            {policy.resource.status === 'failed' ? (
              <p>{c.t('policyFailed')}</p>
            ) : (
              <KeyValue label={c.t('missedPolicy')} rows={policyRows} />
            )}
          </section>
        ) : null
      }
      actions={
        view ? (
          <div>
            <PreviewRefusal refused={engine.refused} />
            <ActionButtons
              actions={['change_repayment_date']}
              busy={engine.busy || !date}
              onAct={(a) =>
                void engine.act(a, (client) => client.call(BANK_LOANS_CHANGE_REPAYMENT_DATE, { loanId: view.sampleLoanId, date }))
              }
            />
          </div>
        ) : null
      }
    />
  );
}

// ---- /bank/cards/credit-card (BK-loan-10: credit card application and rules) --------------------------------------

export function CreditCardPreviewRoom() {
  const c = creditPreviewCopy.useCopy();
  const { resource } = useBankRecord(BANK_CREDIT_CARD_PREVIEW);
  const engine = useEngineAction();
  const [variant, setVariant] = useState<'credit_card' | 'charge_card'>('credit_card');
  const [income, setIncome] = useState('');
  const view = dataOf<CreditCardPreviewView>(resource);
  const item = (raw: string) => raw.replace(/^(variant|fee|restricted):/, '').replaceAll('_', ' ');
  return (
    <FlowTemplate
      title={c.t('cardTitle')}
      description={c.t('cardDescription')}
      state={roomState(c, resource as never, '/bank/cards/credit-card')}
      notices={usePreviewNotice(c)}
      step={
        view ? (
          <form
            data-testid="credit-preview"
            data-room="credit_card"
            aria-label={c.t('cardTitle')}
            onSubmit={(e) => {
              e.preventDefault();
              void engine.act('submit', (client) => client.call(BANK_CREDIT_CARD_APPLICATION, { variant }));
            }}
          >
            <Segmented
              label={c.t('variant')}
              value={variant}
              onChange={setVariant}
              options={[
                { value: 'credit_card', label: c.t('variant_credit_card') },
                { value: 'charge_card', label: c.t('variant_charge_card') },
              ]}
            />
            <Field
              label={c.t('income')}
              hint={c.t('incomeHint')}
              name="income"
              inputMode="decimal"
              value={income}
              onChange={(e) => setIncome(e.target.value)}
            />
            <PreviewRefusal refused={engine.refused} />
            <Button type="submit" tone="primary" disabled={engine.busy}>
              {c.t('action_submit')}
            </Button>
          </form>
        ) : null
      }
      summary={
        view ? (
          <section aria-label={c.t('cardRules')} data-testid="credit-card-rules">
            <h2>{c.t('cardRules')}</h2>
            <EnginePanel name={c.t('cardRules')}>
              {view.tabs.map((tab) => (
                <div key={tab}>
                  <h3>{tk(c, `tab_${tab}`)}</h3>
                  <ul>
                    {view.rows
                      .filter((r) => r.tab === tab)
                      .map((r) => (
                        <li key={r.item} data-testid="credit-card-row">
                          {item(r.item)} {c.t('test')}
                        </li>
                      ))}
                  </ul>
                </div>
              ))}
            </EnginePanel>
          </section>
        ) : null
      }
    />
  );
}

// ---- /bank/cards/credit (BK-cops-09: revolving card credit) -------------------------------------------------------

export function RevolvingCreditPreviewRoom() {
  const c = creditPreviewCopy.useCopy();
  const { resource } = useBankRecord(BANK_CREDIT_PREVIEWS_REVOLVING);
  const engine = useEngineAction();
  const [statementOpen, setStatementOpen] = useState(false);
  const view = dataOf<CreditPreviewRevolving>(resource);
  const sections = view ? [...new Set(view.rows.map((r) => r.section))] : [];
  const act = (action: (typeof CREDIT_PREVIEW_ACTIONS)['revolving_credit'][number]) =>
    void engine.act(action, (client) => client.call(BANK_CREDIT_PREVIEWS_ACT, { product: 'revolving_credit', action }));
  return (
    <FlowTemplate
      title={c.t('revolvingTitle')}
      description={c.t('revolvingDescription')}
      state={roomState(c, resource as never, '/bank/cards/credit')}
      notices={usePreviewNotice(c)}
      step={
        view ? (
          <div data-testid="credit-preview" data-room="revolving_credit">
            {sections.map((section) => {
              const rows = view.rows.filter((r) => r.section === section);
              const hidden = section === 'statements' && !statementOpen;
              return (
                <section key={section} aria-label={tk(c, `section_${section}`)} data-section={section}>
                  <h2>{tk(c, `section_${section}`)}</h2>
                  {section === 'statements' ? (
                    <Button tone="secondary" aria-expanded={statementOpen} onClick={() => setStatementOpen((o) => !o)}>
                      {statementOpen ? c.t('closeStatement') : c.t('openStatement')}
                    </Button>
                  ) : null}
                  {hidden ? null : (
                    <EnginePanel name={tk(c, `section_${section}`)}>
                      <KeyValue
                        label={tk(c, `section_${section}`)}
                        rows={rows.map((r) => ({
                          label: tk(c, `item_${r.item}`),
                          value:
                            r.figure === null
                              ? c.t('test')
                              : section === 'interest_tiers'
                                ? pct(c, r.figure)
                                : money(c, r.figure, view.currency),
                        }))}
                      />
                    </EnginePanel>
                  )}
                </section>
              );
            })}
          </div>
        ) : null
      }
      actions={
        view ? (
          <div>
            <PreviewRefusal refused={engine.refused} />
            <ActionButtons actions={['repay', 'borrow', 'apply'] as const} busy={engine.busy} onAct={act} />
          </div>
        ) : null
      }
    />
  );
}
