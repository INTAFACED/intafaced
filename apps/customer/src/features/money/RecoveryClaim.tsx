import { useId, useState, type FormEvent } from 'react';
import { recoveryClaimMessage } from '@intafaced/contracts/identity-recovery';
import { Button, EmptyState, Failure, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { readRecoveryKey, signWithRecoveryKey } from '../account/recovery-keys';
import { date, funds, useBankRead } from './components';
import { recoveryWrites, type RecoveryAccount, type RecoveryEstate, type RecoverySweep } from './contracts';
import { DepthPanel, DisabledActions, Fact } from './DepthParts';
import { recoveryClaimCopy, type recoveryClaimMessages } from './recovery-claim-copy';
import './bank-depth.css';

/**
 * `/bank/recovery` (RC-identity-08, J-identity-05 #7): the heir's claim room. It lists the accounts whose owner named
 * this person and whose death notice two staff confirmed, with what a claim would move and what still holds it back.
 * The people holding the owner's keys paste them here: each key signs the claim text in this browser, and only the
 * public halves and signatures go to the bank, which asks identity and sweeps the free balances to the heir's main
 * account. The claim text is checked to name this account, this person and this claim before any key signs it.
 */

type Copy = ReturnType<typeof recoveryClaimCopy.useCopy>['t'];
type Refused = Extract<keyof typeof recoveryClaimMessages, `refused_${string}` | `identity_${string}`>;
/** A claim's answer, with the names of the owner's spaces as they were listed when it was sent. */
type Executed = { round: number | null; sweeps: RecoverySweep[]; spaceNames: Record<string, string> };

const bankRefusals: Record<string, Refused> = {
  'bank.recovery_unavailable': 'refused_unavailable',
  'bank.recovery_delegated': 'refused_delegated',
  'bank.recovery_staff_forbidden': 'refused_staff',
  'bank.recovery_estate_not_found': 'refused_notFound',
  'bank.recovery_claim_not_found': 'refused_notFound',
  'bank.recovery_claim_conflict': 'refused_conflict',
  'bank.recovery_blocked': 'refused_blocked',
  'bank.recovery_claim_refused': 'refused_keys',
};
const identityRefusals: Record<string, Refused> = {
  'identity.recovery_notice_unconfirmed': 'identity_notice',
  'identity.recovery_account_changed': 'identity_changed',
  'identity.recovery_changed_after_notice': 'identity_changed',
  'identity.recovery_heir_mismatch': 'identity_heir',
  'identity.recovery_heir_inactive': 'identity_inactive',
  'identity.recovery_threshold_unset': 'identity_threshold',
  'identity.recovery_key_unknown': 'identity_unknown',
  'identity.recovery_key_revoked': 'identity_revoked',
  'identity.recovery_signature_invalid': 'identity_signature',
  'identity.recovery_signatures_short': 'identity_short',
};

/** The typed codes a refusal names: the gateway passes the bank's own code, and identity's, in brackets in the message. */
export function refusalCodes(answer: { code?: string; message: string }): string[] {
  const named = [...answer.message.matchAll(/\[((?:bank|identity)\.[a-z_]+)\]/g)].map((match) => match[1]!);
  return answer.code && /^(bank|identity)\./.test(answer.code) ? [answer.code, ...named] : named;
}

function refusal(t: Copy, answer: { code?: string; message: string }): string {
  const codes = refusalCodes(answer);
  const identity = codes.find((code) => code in identityRefusals);
  if (identity) return `${t('refused_keys')} ${t(identityRefusals[identity]!)} ${t('reference', { code: identity })}`;
  const bank = codes.find((code) => code in bankRefusals);
  return bank ? `${t(bankRefusals[bank]!)} ${t('reference', { code: bank })}` : answer.message;
}

function from(t: Copy, row: Pick<RecoveryAccount, 'ownerType' | 'spaceName'>) {
  if (row.ownerType === 'user') return t('fromMain');
  return row.spaceName ? t('fromSpace', { name: row.spaceName }) : t('fromSpaceUnnamed');
}

function AccountTable({ rows, testId, kind }: { rows: readonly RecoveryAccount[]; testId: string; kind?: boolean }) {
  const { t } = recoveryClaimCopy.useCopy();
  return (
    <div className="withdrawal-address-scroll">
      <table className="bd-table" data-testid={testId}>
        <thead>
          <tr>
            <th scope="col">{t('colAsset')}</th>
            <th scope="col">{t('colFrom')}</th>
            {kind && <th scope="col">{t('colKind')}</th>}
            <th scope="col">{t('colAmount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.ownerType}:${row.spaceId ?? ''}:${row.assetId}:${row.kind}`}>
              <td lang="und">{row.assetId}</td>
              <td lang="und">{from(t, row)}</td>
              {kind && <td lang="und">{row.kind}</td>}
              <td className="numeric">{funds(row.amount, row.assetId)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SweepResult({ done }: { done: Executed }) {
  const { t } = recoveryClaimCopy.useCopy();
  if (done.round === null || done.sweeps.length === 0) return <p role="status">{t('nothingNew')}</p>;
  return (
    <div role="status" data-testid="recovery-moved">
      <p>{done.sweeps.some((sweep) => sweep.status === 'posted') ? t('moved') : t('notMoved')}</p>
      <div className="withdrawal-address-scroll">
        <table className="bd-table">
          <thead>
            <tr>
              <th scope="col">{t('colAsset')}</th>
              <th scope="col">{t('colFrom')}</th>
              <th scope="col">{t('colAmount')}</th>
              <th scope="col">{t('colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {done.sweeps.map((sweep, index) => (
              <tr key={`${sweep.ownerType}:${sweep.assetId}:${index}`}>
                <td lang="und">{sweep.assetId}</td>
                <td lang="und">
                  {from(t, { ownerType: sweep.ownerType, spaceName: sweep.spaceId ? (done.spaceNames[sweep.spaceId] ?? null) : null })}
                </td>
                <td className="numeric">{funds(sweep.amount, sweep.assetId)}</td>
                <td>
                  {sweep.status === 'posted'
                    ? t('sweepPosted')
                    : sweep.status === 'refused'
                      ? t('sweepRefused', { code: sweep.refusalCode ?? '—' })
                      : t('sweepPending')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClaimForm({ estate, onDone }: { estate: RecoveryEstate; onDone: (done: Executed) => void }) {
  const { t } = recoveryClaimCopy.useCopy();
  const { api, userId } = useSession();
  const [keys, setKeys] = useState<string[]>(() => Array.from({ length: estate.threshold }, () => ''));
  const [problems, setProblems] = useState<Array<string | null>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = estate.blockers.length > 0;
  const max = Math.max(estate.threshold, estate.liveKeys);
  const formId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const read = keys.map((text) => (text.trim() ? readRecoveryKey(text) : undefined));
    const seen = new Set<string>();
    const found = read.map((key) => {
      if (key === undefined) return t('keyEmpty');
      if (key === null) return t('keyInvalid');
      const id = `${key.publicKey.x}.${key.publicKey.y}`;
      if (seen.has(id)) return t('keyTwice');
      seen.add(id);
      return null;
    });
    setProblems(found);
    if (found.some(Boolean)) return;
    if (!userId) return setError(t('signedOut'));
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return setError(t('noCrypto'));
    const spaceNames = Object.fromEntries(
      [...estate.sweepable, ...estate.held].flatMap((row) => (row.spaceId && row.spaceName ? [[row.spaceId, row.spaceName]] : [])),
    );
    setBusy(true);
    try {
      const opened = await api.mutate('bank', 'recovery.claims.open', { ownerUserId: estate.userId }, recoveryWrites.open);
      if (!opened.ok) return setError(refusal(t, opened));
      const expected = recoveryClaimMessage({ userId: estate.userId, heirUserId: userId, claimId: opened.data.claimId });
      if (opened.data.message !== expected) return setError(t('messageMismatch'));
      let signatures;
      try {
        signatures = await Promise.all(read.map((key) => signWithRecoveryKey(key!, expected, subtle)));
      } catch {
        return setError(t('noCrypto'));
      }
      const done = await api.mutate(
        'bank',
        'recovery.claims.execute',
        { claimId: opened.data.claimId, signatures },
        recoveryWrites.execute,
      );
      if (!done.ok) return setError(refusal(t, done));
      setKeys(Array.from({ length: estate.threshold }, () => ''));
      onDone({ round: done.data.round, sweeps: done.data.sweeps, spaceNames });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="bd-stack" onSubmit={(event) => void submit(event)} noValidate data-testid="recovery-claim-form">
      <h4>{t('keysTitle')}</h4>
      <p className="money-caption">{t('keysLead')}</p>
      {keys.map((text, index) => {
        const n = String(index + 1);
        const problem = problems[index];
        const hint = `${formId}-key-${index}`;
        return (
          <div className="field" key={index}>
            <label>
              <span>{t('keyField', { n })}</span>
              <textarea
                value={text}
                rows={2}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={Boolean(problem)}
                aria-describedby={problem ? hint : undefined}
                onChange={(event) => setKeys(keys.map((old, at) => (at === index ? event.target.value : old)))}
              />
            </label>
            {problem && (
              <small className="error-text" id={hint}>
                {problem}
              </small>
            )}
            {keys.length > estate.threshold && (
              <Button
                variant="ghost"
                onClick={() => (setKeys(keys.filter((_, at) => at !== index)), setProblems(problems.filter((_, at) => at !== index)))}
              >
                {t('removeKey', { n })}
              </Button>
            )}
          </div>
        );
      })}
      {keys.length < max && (
        <p>
          <Button variant="secondary" onClick={() => setKeys([...keys, ''])}>
            {t('addKey')}
          </Button>
        </p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {blocked ? (
        <DisabledActions labels={[t('claim')]} reason={t('blocked')} variant="primary" />
      ) : (
        <div className="actions">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t('working') : t('claim')}
          </Button>
        </div>
      )}
    </form>
  );
}

function Estate({ estate, done, onDone }: { estate: RecoveryEstate; done: Executed | undefined; onDone: (done: Executed) => void }) {
  const { t } = recoveryClaimCopy.useCopy();
  const claim = estate.claim;
  return (
    <DepthPanel
      title={t('estateTitle', { handle: estate.handle })}
      lead={t('estateLead', { threshold: String(estate.threshold), liveKeys: String(estate.liveKeys) })}
    >
      <dl className="bd-facts">
        <Fact label={t('claimState')}>
          {!claim
            ? t('claimNone')
            : claim.status === 'executed'
              ? t('claimExecuted', { time: date(claim.executedAt) })
              : t('claimOpen', { time: date(claim.createdAt) })}
        </Fact>
      </dl>
      {done && <SweepResult done={done} />}
      <h4>{t('sweepableTitle')}</h4>
      <p className="money-caption">{t('sweepableLead')}</p>
      {estate.sweepable.length > 0 ? (
        <AccountTable rows={estate.sweepable} testId="recovery-sweepable" />
      ) : (
        <p className="muted">{t('sweepableNone')}</p>
      )}
      <h4>{t('heldTitle')}</h4>
      <p className="money-caption">{t('heldLead')}</p>
      {estate.held.length > 0 ? <AccountTable rows={estate.held} testId="recovery-held" kind /> : <p className="muted">{t('heldNone')}</p>}
      {estate.blockers.length > 0 && (
        <>
          <h4>{t('debtsTitle')}</h4>
          <p className="money-caption">{t('debtsLead')}</p>
          <AccountTable rows={estate.blockers} testId="recovery-debts" kind />
        </>
      )}
      <ClaimForm estate={estate} onDone={onDone} />
    </DepthPanel>
  );
}

export function RecoveryClaim() {
  const { t } = recoveryClaimCopy.useCopy();
  const list = useBankRead('recovery.estates', undefined);
  const [done, setDone] = useState<Record<string, Executed>>({});
  if (list.resource.status === 'loading') return <Loading />;
  if (list.resource.status === 'failed') return <Failure result={list.resource.failure} retry={list.reload} />;
  const { estates } = list.resource.data;
  return (
    <div className="bd-stack">
      <p>{t('how')}</p>
      <p role="note">{t('promise')}</p>
      {estates.length === 0 ? (
        <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>
      ) : (
        estates.map((estate) => (
          <Estate
            key={estate.userId}
            estate={estate}
            done={done[estate.userId]}
            onDone={(result) => {
              setDone((before) => ({ ...before, [estate.userId]: result }));
              list.reload();
            }}
          />
        ))
      )}
    </div>
  );
}
