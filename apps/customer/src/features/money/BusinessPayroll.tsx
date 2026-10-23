import { useState } from 'react';
import type { z } from 'zod';
import { Button, Field, Loading } from '../../shared/ui';
import { decimalSchema, formatAmount, parseAmount } from '../../shared/money';
import { DepthPanel, DisabledAction, Fact } from './DepthParts';
import { businessCopy } from './business-copy';
import {
  buildPayrollInput,
  canRunPayroll,
  payrollMatches,
  payrollProblem,
  payrollTotal,
  MAX_PAYROLL_LINES,
  type PayrollLine,
  type PayrollProblem,
} from './business-model';
import { PersonFinder, roleOf, type FoundPerson, type RoleState } from './BusinessPeople';
import { amount as exactAmount, funds, type ActionSpec } from './components';
import type { businessSchema } from './contracts';
import './bank-depth.css';

type Business = z.infer<typeof businessSchema>;
type OwnSpace = { id: string; name: string; assetId: string; balance: string };

type BusinessCopy = ReturnType<typeof businessCopy.forLocale>;

/**
 * The review for a payroll: the source account, every person with their exact amount, the total and the limit it is
 * under. Amounts are always exact figures, even when balances are hidden elsewhere on the screen.
 */
export function payrollSpec(
  copy: BusinessCopy,
  account: Business,
  source: OwnSpace,
  sent: readonly PayrollLine[],
  total: bigint,
): ActionSpec {
  const { t } = copy;
  const exact = (value: string | null) => exactAmount(value, account.assetId);
  return {
    title: t('payrollTitle'),
    procedure: 'business.runPayroll',
    facts: [
      [t('payrollSource'), `${source.name} · ${exact(source.balance)}`],
      ...sent.map((line): [string, string] => [`@${line.handle}`, exact(line.amount)]),
      [t('payrollTotal'), exact(formatAmount(total))],
      [t('payrollLimit'), exact(account.spendThreshold)],
    ],
    notes: [t('payrollNote'), t('payrollOnce'), t('needsSecondStep')],
    submit: t('payrollSubmit'),
    // The request id is the payroll id: sending this same payroll again is recognised by the bank and paid once.
    input: (_values, requestId) => buildPayrollInput(requestId, account.id, source.id, sent),
    verifyOutcome: payrollMatches,
    describeOutcome: (data) => {
      const run = data as { recipients: Array<{ toSpaceId: string; amount: string }> };
      const name = (id: string) => sent.find((line) => line.toSpaceId.toLowerCase() === id.toLowerCase())?.handle;
      return [
        [t('outcomeResult'), t('payrollDone')],
        ...run.recipients.map((row): [string, string] => [
          name(row.toSpaceId) ? `@${name(row.toSpaceId)}` : row.toSpaceId,
          exact(row.amount),
        ]),
        [t('payrollTotal'), exact(formatAmount(run.recipients.reduce((sum, row) => sum + parseAmount(row.amount), 0n)))],
      ];
    },
  };
}

/**
 * Run payroll: pay several people from one account in a single step.
 *
 * The bank lets administrators and makers do this, with no second approver, so the total has to stay below the
 * approval limit. Every person and exact amount is listed and totalled here, and again in the review that comes before
 * anything is sent. The request carries the payroll's own reference, so sending the same payroll twice pays once.
 */
export function PayrollRun({
  account,
  own,
  role,
  open,
}: {
  account: Business;
  own: readonly OwnSpace[];
  role: RoleState;
  open: (spec: ActionSpec) => void;
}) {
  const copy = businessCopy.useCopy();
  const { t } = copy;
  const [sourceId, setSourceId] = useState(own[0]?.id ?? '');
  const [lines, setLines] = useState<PayrollLine[]>([]);
  const [person, setPerson] = useState<FoundPerson | null>(null);
  const [amount, setAmount] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  // A payroll is always read back in exact figures, even when the customer has chosen to hide balances elsewhere.
  const exact = (value: string | null) => exactAmount(value, account.assetId);
  const source = own.find((space) => space.id === sourceId) ?? own[0];
  const known = roleOf(role);
  const total = payrollTotal(lines);
  const problem: PayrollProblem | null = source
    ? payrollProblem({ lines, fromSpaceId: source.id, threshold: account.spendThreshold, balance: source.balance })
    : 'empty';
  const words = (which: PayrollProblem): string =>
    which === 'empty'
      ? t('payrollProblemEmpty')
      : which === 'tooMany'
        ? t('payrollProblemTooMany')
        : which === 'amount'
          ? t('payrollProblemAmount')
          : which === 'duplicate'
            ? t('payrollProblemDuplicate')
            : which === 'source'
              ? t('payrollProblemSource')
              : which === 'overLimit'
                ? t('payrollProblemLimit', { limit: exact(account.spendThreshold) })
                : t('payrollProblemBalance', { available: exact(source?.balance ?? null) });

  function addLine() {
    if (!person) return;
    const typed = amount.trim();
    if (!decimalSchema.safeParse(typed).success || parseAmount(typed) <= 0n) {
      setIssue(t('payrollProblemAmount'));
      return;
    }
    if (lines.some((line) => line.toSpaceId.toLowerCase() === person.spaceId.toLowerCase())) {
      setIssue(t('payrollAlready', { handle: person.handle }));
      return;
    }
    if (lines.length >= MAX_PAYROLL_LINES) {
      setIssue(t('payrollProblemTooMany'));
      return;
    }
    setLines([...lines, { handle: person.handle, toSpaceId: person.spaceId, amount: typed }]);
    setPerson(null);
    setAmount('');
    setIssue(null);
  }

  function review() {
    if (!source || problem !== null || total === null) return;
    open(payrollSpec(copy, account, source, [...lines], total));
  }

  if (role.status === 'loading')
    return (
      <DepthPanel title={t('payrollTitle')}>
        <Loading />
      </DepthPanel>
    );
  if (known !== null && !canRunPayroll(known))
    return (
      <DepthPanel title={t('payrollTitle')} lead={t('payrollLead')}>
        <DisabledAction label={t('payrollReview')} reason={t('payrollRoleReason')} />
      </DepthPanel>
    );
  if (account.status !== 'active')
    return (
      <DepthPanel title={t('payrollTitle')} lead={t('payrollLead')}>
        <DisabledAction label={t('payrollReview')} reason={t('closed')} />
      </DepthPanel>
    );
  if (!source)
    return (
      <DepthPanel title={t('payrollTitle')} lead={t('payrollLead')}>
        <DisabledAction label={t('payrollReview')} reason={t('payrollNoSource', { asset: account.assetId })} />
      </DepthPanel>
    );
  return (
    <DepthPanel title={t('payrollTitle')} lead={t('payrollLead')}>
      {role.status === 'failed' && <p className="money-caption">{t('roleUnreadable')}</p>}
      <label className="field">
        <span>{t('payrollSource')}</span>
        <select value={source.id} onChange={(event) => setSourceId(event.target.value)}>
          {own.map((space) => (
            <option key={space.id} value={space.id}>
              {`${space.name} · ${funds(space.balance, space.assetId)}`}
            </option>
          ))}
        </select>
      </label>
      <h4 className="bd-subhead">{t('payrollAddTitle')}</h4>
      <PersonFinder accountId={account.id} assetId={account.assetId} person={person} onChange={setPerson} />
      {person && (
        <form
          className="bd-recipient__search"
          onSubmit={(event) => {
            event.preventDefault();
            addLine();
          }}
        >
          <Field
            name="payrollAmount"
            label={`${t('sendAmount')} (${account.assetId})`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            error={issue ?? undefined}
            onChange={(event) => {
              setAmount(event.target.value);
              setIssue(null);
            }}
          />
          <Button type="submit" variant="secondary" disabled={!amount.trim()}>
            {t('payrollAddLine')}
          </Button>
        </form>
      )}
      <h4 className="bd-subhead">{t('payrollLines')}</h4>
      {lines.length === 0 ? (
        <p className="money-caption">{t('payrollNoLines')}</p>
      ) : (
        <ul className="bd-team">
          {lines.map((line) => (
            <li key={line.toSpaceId} className="bd-team__row">
              <strong lang="zxx" dir="ltr">
                @{line.handle}
              </strong>
              <span className="numeric" lang="zxx" dir="ltr">
                {exact(line.amount)}
              </span>
              <Button
                variant="ghost"
                aria-label={t('payrollRemove', { handle: line.handle })}
                onClick={() => setLines(lines.filter((each) => each.toSpaceId !== line.toSpaceId))}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      <dl className="bd-facts">
        <Fact label={t('payrollPeople')}>{lines.length}</Fact>
        <Fact label={t('payrollTotal')}>
          <span className="numeric" lang="zxx" dir="ltr">
            {total === null ? '—' : exact(formatAmount(total))}
          </span>
        </Fact>
        <Fact label={t('payrollLimit')}>
          <span className="numeric" lang="zxx" dir="ltr">
            {exact(account.spendThreshold)}
          </span>
        </Fact>
        <Fact label={t('payrollAvailable')}>
          <span className="numeric" lang="zxx" dir="ltr">
            {exact(source.balance)}
          </span>
        </Fact>
      </dl>
      <div className="actions">
        <Button onClick={review} disabled={problem !== null} aria-describedby={problem ? 'payroll-why' : undefined}>
          {t('payrollReview')}
        </Button>
      </div>
      {problem && (
        <p id="payroll-why" className="money-caption" role="status">
          {words(problem)}
        </p>
      )}
    </DepthPanel>
  );
}
