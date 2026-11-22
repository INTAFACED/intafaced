import { useEffect, useRef, useState, type FormEvent } from 'react';
import { COMPROMISE_NOTE_MAX, type CompromiseCase, type CompromiseChecklistItem } from '@intafaced/contracts/identity-compromise';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { Button, Field } from '@intafaced/ui/lit';
import { SettingsTemplate } from '@intafaced/ui/lit/templates';
import { Failure, Loading } from './kit-parts';
import { stamp } from '../../screens/money/time';
import { compromiseCopy as copy } from './compromise-copy';
import {
  IDENTITY_ACCOUNT_COMPROMISED_MARK_REVIEWED,
  IDENTITY_ACCOUNT_COMPROMISED_MINE,
  IDENTITY_ACCOUNT_COMPROMISED_START,
  IDENTITY_ACCOUNT_COMPROMISED_REPORT_STOLEN_FUNDS,
} from '@intafaced/contracts/identity-account-procedures';

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
      userId ? api.call(IDENTITY_ACCOUNT_COMPROMISED_MINE, undefined, { signal }) : Promise.resolve({ ok: true as const, data: null }),
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
  // While the case reloads after a change (a report filed, a review made), the page keeps showing the case it has, so the
  // forms and what they just said ("Report filed on your case.") stay; only the first read shows the loading state.
  const last = useRef<{ case: CompromiseCase | null } | null>(null);
  if (resource.status === 'ready') last.current = { case: resource.data?.case ?? null };
  const shown = resource.status === 'ready' || resource.status === 'loading' ? last.current : null;
  const sections: readonly (readonly [
    'compromised-what' | 'compromised-case' | 'compromised-stolen',
    'whatTitle' | 'caseTitle' | 'stolenTitle',
  ])[] = shown?.case
    ? [
        ['compromised-case', 'caseTitle'],
        ['compromised-stolen', 'stolenTitle'],
      ]
    : [['compromised-what', 'whatTitle']];
  return (
    <div data-testid="compromised" lang={languageFor('title')}>
      <SettingsTemplate
        title={t('title')}
        description={t('intro')}
        state={{ kind: 'ready' }}
        index={
          <nav aria-label={t('sectionsLabel')}>
            <ul>
              {sections.map(([id, key]) => (
                <li key={id}>
                  <a className="lt-link" href={`#${id}`}>
                    {t(key)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        }
        sections={
          <>
            {resource.status === 'loading' && !shown && <Loading />}
            {resource.status === 'failed' && <Failure result={resource.failure} retry={reload} />}
            {shown && (shown.case ? <OpenCase open={shown.case} reload={reload} /> : <Start />)}
            <p className="lt-hint">
              <a className="lt-link" href="/help/official-channels">
                {t('scamLinks')}
              </a>{' '}
              ·{' '}
              <a className="lt-link" href="/support/new?topic=phishing">
                {t('reportScam')}
              </a>
            </p>
          </>
        }
        explain={<p>{t('explain')}</p>}
      />
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
      const answer = await api.call(IDENTITY_ACCOUNT_COMPROMISED_START, { password });
      if (!answer.ok) return setFailure(answer);
      // This sign-in ended too, so the page says so and reads nothing more: the next sign-in shows the case.
      setSecured(true);
    } finally {
      setBusy(false);
    }
  }

  if (secured) {
    return (
      <section data-testid="security__card" role="status">
        <h2>{t('securedTitle')}</h2>
        <p>{t('securedBody')}</p>
      </section>
    );
  }
  const refusal = failure?.code ? START_REFUSALS[failure.code] : undefined;
  return (
    <section data-testid="security__card" aria-labelledby="compromised-what">
      <h2 id="compromised-what">{t('whatTitle')}</h2>
      <ul data-testid="compromised__what">
        <li>{t('whatSessions')}</li>
        <li>{t('whatFreeze')}</li>
        <li>{t('whatCase')}</li>
        <li>{t('whatAfter')}</li>
      </ul>
      {failure &&
        (refusal ? (
          <p className="lt-refusal" role="alert">
            {t(refusal)}
          </p>
        ) : (
          <Failure result={failure} />
        ))}
      <form ref={form} method="post" onSubmit={submit} noValidate>
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
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={busy}>
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
      const answer = await api.call(IDENTITY_ACCOUNT_COMPROMISED_MARK_REVIEWED, { item });
      if (!answer.ok) return setFailure(answer);
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section data-testid="compromised__case" data-case-id={open.id} aria-labelledby="compromised-case">
        <h2 id="compromised-case">{t('caseTitle')}</h2>
        <p>{t('caseOpened', { date: stamp(open.openedAt, timeZone), sessions: open.sessionsEnded, keys: open.keysEnded })}</p>
        <h3>{t('checklistTitle')}</h3>
        <p className="lt-hint">{t('checklistBody')}</p>
        {failure && <Failure result={failure} />}
        <ol data-testid="compromised__checklist">
          {open.checklist.map(({ item, doneAt }) => (
            <li key={item} data-item={item} data-done={doneAt !== null}>
              <div>
                <strong>{t(item)}</strong> <span className="lt-chip">{doneAt ? t('done') : t('pending')}</span>
                {doneAt && <span className="lt-hint"> · {t('doneOn', { date: stamp(doneAt, timeZone) })}</span>}
                {!doneAt && <p className="lt-hint">{t(`${item}Why`)}</p>}
                <p>
                  <a className="lt-link" href={ITEM_LINKS[item]}>
                    {t(`${item}Link`)}
                  </a>
                </p>
                {item === 'addresses' && !doneAt && (
                  <Button tone="secondary" disabled={busy} onClick={() => void reviewed('addresses')}>
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
      const answer = await api.call(IDENTITY_ACCOUNT_COMPROMISED_REPORT_STOLEN_FUNDS, {
        body: text,
        clientRequestId: `stolen-funds:${requestId}`,
      });
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
    <section data-testid="compromised__stolen-funds" aria-labelledby="compromised-stolen">
      <h2 id="compromised-stolen">{t('stolenTitle')}</h2>
      <p>{t('stolenBody')}</p>
      {filed && <p role="status">{t('stolenFiled')}</p>}
      {failure && <Failure result={failure} />}
      <form onSubmit={submit} noValidate>
        <label className="lt-field">
          <span>{t('stolenField')}</span>
          <textarea lang="und" value={body} onChange={(event) => setBody(event.target.value)} rows={5} disabled={busy} />
          <small className="lt-hint">
            {problem ? t(problem, { max: COMPROMISE_NOTE_MAX }) : t('stolenHint', { max: COMPROMISE_NOTE_MAX })}
          </small>
        </label>
        <div className="lt-actions">
          <Button type="submit" tone="primary" disabled={busy}>
            {t('stolenSend')}
          </Button>
        </div>
      </form>
      <h3>{t('notesTitle')}</h3>
      {open.notes.length === 0 ? (
        <p className="lt-hint">{t('notesNone')}</p>
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
