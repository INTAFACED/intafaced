import { useState, type FormEvent } from 'react';
import { Button, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import type { Resource } from '../../shared/resource';
import { useSession } from '../session/session';
import { date, useBankRead } from './components';
import { linkedAccountWrites, type LinkedAccount } from './contracts';
import { DepthPanel } from './DepthParts';
import { linkedAccountsCopy } from './linked-accounts-copy';
import { WithdrawStepUp } from './WithdrawStepUp';
import './bank-depth.css';

/**
 * Linked bank accounts (J-bank-02 #6): the person's own accounts at other banks, each listed with its state and whether
 * it can be used. Every account starts unverified, and only a banking partner can verify one, so while none is wired
 * each row says so with `rail.bank`. Linking and removing each ask for a fresh confirmation (`trade:withdraw`), as a
 * withdrawal address does. The IBAN is shown only as the bank masks it.
 */

/** The IBAN without spaces when it passes its mod-97 check digits. The bank checks it again; this only saves a code. */
export function ibanOk(raw: string): boolean {
  const compact = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  let remainder = 0;
  for (const ch of compact.slice(4) + compact.slice(0, 4)) {
    const digits = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

const refusalWords: Record<string, 'refusedFull' | 'refusedCapUnset' | 'refusedInvalid'> = {
  'bank.linked_accounts_full': 'refusedFull',
  'bank.address_book_cap_unset': 'refusedCapUnset',
  'bank.linked_account_invalid': 'refusedInvalid',
};

const nameOk = (value: string, max: number) => value.trim().length >= 1 && value.trim().length <= max;

function UseCell({ row }: { row: LinkedAccount }) {
  const { t } = linkedAccountsCopy.useCopy();
  if (row.usable) return <>{t('useYes')}</>;
  const [words, code]: [string, string] =
    row.blocker === 'bank.linked_account_unverified'
      ? [t('useUnverified', { rail: row.verificationRail ?? 'rail.bank' }), row.blocker]
      : row.blocker === 'bank.offramp_cooling_active' && row.coolingOffEndsAt
        ? [t('useCooling', { time: date(row.coolingOffEndsAt) }), row.blocker]
        : [t('useCoolingUnset'), row.blocker ?? 'bank.offramp_cooling_unset'];
  return (
    <>
      {words} <small className="muted">{t('reference', { code })}</small>
    </>
  );
}

export function LinkedAccountTable({ rows, onRemove }: { rows: readonly LinkedAccount[]; onRemove?: (row: LinkedAccount) => void }) {
  const { t } = linkedAccountsCopy.useCopy();
  return (
    <>
      <div className="withdrawal-address-scroll">
        <table className="bd-table" data-testid="linked-accounts">
          <thead>
            <tr>
              <th scope="col">{t('colName')}</th>
              <th scope="col">{t('colHolder')}</th>
              <th scope="col">{t('colAccount')}</th>
              <th scope="col">{t('colState')}</th>
              <th scope="col">{t('colUse')}</th>
              <th scope="col">{t('colLinked')}</th>
              <th scope="col">{t('colActions')}</th>
            </tr>
          </thead>
          {rows.length > 0 && (
            <tbody>
              {rows.map((row) => (
                <tr key={row.accountId} data-testid={`linked-${row.accountId}`}>
                  <td lang="und">{row.label}</td>
                  <td lang="und">{row.holderName}</td>
                  <td className="numeric" lang="und">
                    {row.ibanMasked}
                  </td>
                  <td>{t(row.state === 'verified' ? 'state_verified' : 'state_unverified')}</td>
                  <td>
                    <UseCell row={row} />
                  </td>
                  <td>{date(row.linkedAt)}</td>
                  <td>
                    {onRemove && (
                      <Button variant="ghost" onClick={() => onRemove(row)}>
                        {t('remove')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
      {rows.length === 0 && <EmptyState title={t('empty')}>{t('emptyBody')}</EmptyState>}
    </>
  );
}

export function LinkedAccountList({
  resource,
  reload,
  onRemove,
}: {
  resource: Resource<{ accounts: LinkedAccount[] }>;
  reload: () => void;
  onRemove?: (row: LinkedAccount) => void;
}) {
  if (resource.status === 'loading') return <Loading />;
  if (resource.status === 'failed') return <Failure result={resource.failure} retry={reload} />;
  return <LinkedAccountTable rows={resource.data.accounts} onRemove={onRemove} />;
}

type Draft = { label: string; holderName: string; iban: string };
const EMPTY: Draft = { label: '', holderName: '', iban: '' };

export function draftProblems(draft: Draft) {
  return {
    label: nameOk(draft.label, 64) ? null : ('nameBad' as const),
    holderName: nameOk(draft.holderName, 140) ? null : ('holderBad' as const),
    iban: ibanOk(draft.iban) ? null : ('ibanBad' as const),
  };
}

function LinkForm({ onLinked }: { onLinked: () => void }) {
  const { t } = linkedAccountsCopy.useCopy();
  const { api } = useSession();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const problems = draftProblems(draft);
  const shown = (key: keyof Draft) => (tried ? problems[key] : null);
  const set = (patch: Partial<Draft>) => {
    setDone(null);
    setDraft((before) => ({ ...before, ...patch }));
  };
  const input = { label: draft.label.trim(), holderName: draft.holderName.trim(), iban: draft.iban.replace(/\s+/g, '').toUpperCase() };
  function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    if (Object.values(problems).some((p) => p !== null)) return;
    setConfirming(true);
  }
  return (
    <>
      <form className="bd-stack" onSubmit={submit} noValidate aria-label={t('addTitle')}>
        <Field
          label={t('name')}
          hint={t('nameHint')}
          value={draft.label}
          maxLength={64}
          autoComplete="off"
          onChange={(event) => set({ label: event.target.value })}
          error={shown('label') ? t('nameBad') : undefined}
        />
        <Field
          label={t('holder')}
          hint={t('holderHint')}
          value={draft.holderName}
          maxLength={140}
          autoComplete="name"
          onChange={(event) => set({ holderName: event.target.value })}
          error={shown('holderName') ? t('holderBad') : undefined}
        />
        <Field
          label={t('iban')}
          hint={t('ibanHint')}
          value={draft.iban}
          maxLength={64}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          onChange={(event) => set({ iban: event.target.value })}
          error={shown('iban') ? t('ibanBad') : undefined}
        />
        <div className="actions">
          <Button type="submit" variant="primary">
            {t('link')}
          </Button>
        </div>
        {done && <p role="status">{done}</p>}
      </form>
      {confirming && (
        <WithdrawStepUp
          why={t('linkWhy')}
          run={async (token) => {
            const answer = await api.mutate('bank', 'linkedAccounts.link', input, linkedAccountWrites.link, { bearer: token });
            if (!answer.ok) {
              // The bank's own refusals in the person's words, with the code to quote; anything else as the bank said it.
              const words = answer.code ? refusalWords[answer.code] : undefined;
              return words ? { ...answer, message: `${t(words)} ${t('reference', { code: answer.code! })}` } : answer;
            }
            const name = answer.data.account.label;
            setDone(answer.data.created ? t('linked', { name }) : t('already', { name }));
            return answer;
          }}
          onDone={() => {
            setConfirming(false);
            setDraft(EMPTY);
            setTried(false);
            onLinked();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

/** `/bank/ramps/accounts`: the person's linked bank accounts and the form to link one. */
export function LinkedAccounts() {
  const { t } = linkedAccountsCopy.useCopy();
  const { api } = useSession();
  const list = useBankRead('linkedAccounts.list', undefined);
  const [removing, setRemoving] = useState<LinkedAccount | null>(null);
  const [removed, setRemoved] = useState<string | null>(null);
  return (
    <div className="bd-stack">
      <DepthPanel title={t('listTitle')} lead={t('listLead')}>
        <LinkedAccountList
          resource={list.resource}
          reload={list.reload}
          onRemove={(row) => {
            setRemoved(null);
            setRemoving(row);
          }}
        />
        {removed && <p role="status">{t('removed', { name: removed })}</p>}
      </DepthPanel>
      <DepthPanel title={t('addTitle')} lead={t('addLead')}>
        <LinkForm onLinked={list.reload} />
      </DepthPanel>
      {removing && (
        <WithdrawStepUp
          why={t('removeWhy', { account: `${removing.label} (${removing.ibanMasked})` })}
          run={(token) =>
            api.mutate('bank', 'linkedAccounts.remove', { accountId: removing.accountId }, linkedAccountWrites.remove, { bearer: token })
          }
          onDone={() => {
            setRemoved(removing.label);
            setRemoving(null);
            list.reload();
          }}
          onCancel={() => setRemoving(null)}
        />
      )}
      <p>
        <a className="text-link" href="/bank/ramps">
          {t('back')}
        </a>
      </p>
    </div>
  );
}
