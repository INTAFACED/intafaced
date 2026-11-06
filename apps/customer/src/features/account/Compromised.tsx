import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  COMPROMISE_NOTE_MAX,
  compromiseMineOutputSchema,
  compromiseReportOutputSchema,
  compromiseReviewOutputSchema,
  compromiseStartOutputSchema,
  type CompromiseCase,
  type CompromiseChecklistItem,
} from '@intafaced/contracts/identity-compromise';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { Button, Failure, Field, Loading } from '../../shared/ui';
import { stamp } from '../../screens/money/time';
import { compromiseCopy as copy } from './compromise-copy';
import './security.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;

/** Typed refusals the page words itself; anything else falls through to the shared failure view. */
const START_REFUSALS: Readonly<Record<string, 'refusedPassword' | 'refusedDelegated'>> = {
  'auth.invalid_credentials': 'refusedPassword',
  'auth.mfa_required': 'refusedDelegated',
};

/** Where each checklist item is worked. The review items are marked by the person after they look. */
const ITEM_LINKS: Readonly<Record<CompromiseChecklistItem, string>> = {
  password: '/uc/safe#password',
  second_factor: '/uc/safe',
  devices: '/uc/safe#devices',
  api_keys: '/uc/safe/api-keys',
  addresses: '/uc/withdraw/address',
};

/** The person's open case, as identity answers it; null when none is open. */
export function useCompromiseCase() {
  const { api, userId } = useSession();
  return useResource(
    (signal) =>
      userId
        ? api.query('identity', 'account.compromised.mine', undefined, compromiseMineOutputSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `compromise-case:${userId}`,
  );
}

/**
 * "My account is compromised" (`/uc/safe/compromised`, I-signin-sessions-28, J-identity-13 #3 to #5). Before a case: what
 * pressing does, then the password and one button that ends every sign-in and key, freezes the account and opens the
 * case (identity does all of it in one step). With a case: the checklist, which ticks from what identity sees, and the
 * stolen-funds report, a note that moves no money. Nothing here promises funds back.
 */
export function Compromised() {
  const { t, languageFor } = copy.useCopy();
  const { resource, reload } = useCompromiseCase();
  return (
    <div data-testid="compromised" className="security stack" lang={languageFor('title')}>
      <header>
        <h1>{t('title')}</h1>
        <p className="muted">{t('intro')}</p>
      </header>
      {resource.status === 'loading' && <Loading />}
      {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
      {resource.status === 'ready' && (resource.data?.case ? <OpenCase open={resource.data.case} reload={reload} /> : <Start />)}
      <p className="muted">
        <a className="text-link" href="/help/official-channels">
          {t('scamLinks')}
        </a>{' '}
        ·{' '}
        <a className="text-link" href="/support/new?topic=phishing">
          {t('reportScam')}
        </a>
      </p>
    </div>
  );
}

function Start() {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [secured, setSecured] = useState(false);
  const form = useRef<HTMLFormElement | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const password = String(new FormData(event.currentTarget).get('compromise-password') ?? '');
    if (password.length === 0) return setProblem(true);
    setProblem(false);
    form.current?.reset();
    setBusy(true);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'account.compromised.start', { password }, compromiseStartOutputSchema);
      if (!answer.ok) return setFailure(answer);
      // This sign-in ended too, so the page says so and reads nothing more: the next sign-in shows the case.
      setSecured(true);
    } finally {
      setBusy(false);
    }
  }

  if (secured) {
    return (
      <section data-testid="security__card" className="security__card" role="status">
        <h2>{t('securedTitle')}</h2>
        <p>{t('securedBody')}</p>
      </section>
    );
  }
  const refusal = failure?.code ? START_REFUSALS[failure.code] : undefined;
  return (
    <section data-testid="security__card" className="security__card" aria-labelledby="compromised-what">
      <h2 id="compromised-what">{t('whatTitle')}</h2>
      <ul data-testid="compromised__what">
        <li>{t('whatSessions')}</li>
        <li>{t('whatFreeze')}</li>
        <li>{t('whatCase')}</li>
        <li>{t('whatAfter')}</li>
      </ul>
      {failure &&
        (refusal ? (
          <p className="notice" role="alert">
            {t(refusal)}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      <form ref={form} method="post" className="stack" onSubmit={submit} noValidate>
        <Field
          label={t('passwordField')}
          name="compromise-password"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
          error={problem ? t('passwordNeeded') : undefined}
          data-security-sensitive="true"
        />
        <div className="actions">
          <Button type="submit" variant="danger" disabled={busy}>
            {busy ? t('working') : t('start')}
          </Button>
        </div>
      </form>
    </section>
  );
}

function OpenCase({ open, reload }: { open: CompromiseCase; reload: () => void }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const { timeZone } = usePreferences();
  const [failure, setFailure] = useState<Failed | null>(null);
  const [busy, setBusy] = useState(false);

  async function reviewed(item: 'addresses') {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const answer = await api.mutate('identity', 'account.compromised.markReviewed', { item }, compromiseReviewOutputSchema);
      if (!answer.ok) return setFailure(answer);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section data-testid="compromised__case" data-case-id={open.id} className="security__card" aria-labelledby="compromised-case">
        <h2 id="compromised-case">{t('caseTitle')}</h2>
        <p>{t('caseOpened', { date: stamp(open.openedAt, timeZone), sessions: open.sessionsEnded, keys: open.keysEnded })}</p>
        <h3>{t('checklistTitle')}</h3>
        <p className="muted">{t('checklistBody')}</p>
        {failure && <Failure result={failure} />}
        <ol data-testid="compromised__checklist" className="security__rows">
          {open.checklist.map(({ item, doneAt }) => (
            <li key={item} data-item={item} data-done={doneAt !== null} className="security__row">
              <div>
                <strong>{t(item)}</strong> <span className="badge">{doneAt ? t('done') : t('pending')}</span>
                {doneAt && <span className="muted"> · {t('doneOn', { date: stamp(doneAt, timeZone) })}</span>}
                {!doneAt && <p className="muted">{t(`${item}Why`)}</p>}
                <p>
                  <a className="text-link" href={ITEM_LINKS[item]}>
                    {t(`${item}Link`)}
                  </a>
                </p>
                {item === 'addresses' && !doneAt && (
                  <Button variant="secondary" disabled={busy} onClick={() => void reviewed('addresses')}>
                    {t('addressesReviewed')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <StolenFunds open={open} onFiled={reload} />
    </>
  );
}

function StolenFunds({ open, onFiled }: { open: CompromiseCase; onFiled: () => void }) {
  const { t } = copy.useCopy();
  const { api } = useSession();
  const { timeZone } = usePreferences();
  const [body, setBody] = useState('');
  const [problem, setProblem] = useState<'stolenNeeded' | 'stolenTooLong' | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const [filed, setFiled] = useState(false);
  const [busy, setBusy] = useState(false);
  // One request id per report text: a resend of the same words after a lost answer is the same note, and edited words
  // are a new note, never dropped as a repeat.
  const request = useRef<{ text: string; id: string } | null>(null);
  useEffect(() => {
    if (body.trim().length > 0) setFiled(false);
  }, [body]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const text = body.trim();
    if (text.length === 0) return setProblem('stolenNeeded');
    if (text.length > COMPROMISE_NOTE_MAX) return setProblem('stolenTooLong');
    setProblem(null);
    setBusy(true);
    setFailure(null);
    if (request.current?.text !== text) request.current = { text, id: crypto.randomUUID() };
    const requestId = request.current.id;
    try {
      const answer = await api.mutate(
        'identity',
        'account.compromised.reportStolenFunds',
        { body: text, clientRequestId: `stolen-funds:${requestId}` },
        compromiseReportOutputSchema,
      );
      if (!answer.ok) return setFailure(answer);
      request.current = null;
      setBody('');
      setFiled(true);
      onFiled();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="compromised__stolen-funds" className="security__card" aria-labelledby="compromised-stolen">
      <h2 id="compromised-stolen">{t('stolenTitle')}</h2>
      <p>{t('stolenBody')}</p>
      {filed && <p role="status">{t('stolenFiled')}</p>}
      {failure && <Failure result={failure} />}
      <form className="stack" onSubmit={submit} noValidate>
        <label className="field">
          <span>{t('stolenField')}</span>
          <textarea lang="und" value={body} onChange={(event) => setBody(event.target.value)} rows={5} disabled={busy} />
          <small className={problem ? 'error-text' : ''}>
            {problem ? t(problem, { max: COMPROMISE_NOTE_MAX }) : t('stolenHint', { max: COMPROMISE_NOTE_MAX })}
          </small>
        </label>
        <div className="actions">
          <Button type="submit" disabled={busy}>
            {t('stolenSend')}
          </Button>
        </div>
      </form>
      <h3>{t('notesTitle')}</h3>
      {open.notes.length === 0 ? (
        <p className="muted">{t('notesNone')}</p>
      ) : (
        <ul data-testid="compromised__notes">
          {open.notes.map((note) => (
            <li key={note.id} lang="und">
              <time dateTime={note.createdAt}>{stamp(note.createdAt, timeZone)}</time> {note.body}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
