import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccountRestriction } from '@intafaced/contracts/identity-account-status';
import { appealSchema, appealsMineSchema, APPEAL_TEXT_MAX, type Appeal } from '@intafaced/contracts/identity-appeals';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { Failure, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { stamp } from '../../screens/money/time';
import { appealsCopy as copy } from './appeals-copy';

const APPEALABLE = new Set<AccountRestriction['kind']>(['trading_restricted']);
const OPEN = new Set<Appeal['status']>(['submitted', 'in_review']);
const REFUSALS = new Set([
  'identity.appeal_open',
  'identity.appeal_window_unset',
  'identity.appeal_window_closed',
  'identity.appeal_no_restriction',
  'identity.appeal_setter_unknown',
  'identity.appeal_request_conflict',
]);

/**
 * I-account-lifecycle-12 (J-identity-14 #3, #4): the appeal panel under the account status. It shows every appeal the
 * person filed with its status and, once decided, the outcome and the owner's words for the reason. While an appealable
 * restriction holds and no appeal of it is open, it offers the form; with the owner's window unset it says appeals are
 * closed. Everything here is read from identity's `accountAppeal.mine`; a refusal names its code.
 */
export function AccountAppeals({ restrictions }: { restrictions: readonly AccountRestriction[] }) {
  const { api, userId } = useSession();
  const { t, Copy } = copy.useCopy();
  const { timeZone } = usePreferences();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // One key per appeal the person is writing: a retry after a lost answer is the same appeal, never a second.
  const requestKey = useRef<string>(crypto.randomUUID());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const appealable = restrictions.find((r) => APPEALABLE.has(r.kind));
  const { resource, reload } = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'accountAppeal.mine', undefined, appealsMineSchema, { signal })
        : Promise.resolve({ ok: true as const, data: null }),
    `account-appeals:${userId}`,
  );

  if (resource.status === 'loading') return <Loading />;
  // An API key or a sub-account cannot appeal for the account, and has nothing to show here.
  if (resource.status === 'failed' && resource.failure.code === 'identity.delegated_refused') return null;
  if (resource.status === 'failed')
    return (
      <section className="account-appeals" data-testid="account-appeals">
        <h3>
          <Copy k="readFailed" />
        </h3>
        <Failure result={resource.failure} retry={reload} />
      </section>
    );
  const mine = resource.data;
  if (!mine || (!appealable && mine.appeals.length === 0)) return null;
  const openOne = mine.appeals.some((a) => OPEN.has(a.status));

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !appealable) return;
    const words = text.trim();
    if (words.length === 0) return setEmpty(true);
    setEmpty(false);
    setBusy(true);
    setRefusal(null);
    setNote(null);
    try {
      const answer = await api.mutate(
        'identity',
        'accountAppeal.submit',
        { restriction: 'trading_restricted', text: words, clientRequestId: requestKey.current },
        appealSchema,
      );
      if (!mounted.current) return;
      if (!answer.ok) {
        setRefusal(answer.code ?? 'unknown');
        // Read the list again: an unclear answer may hide an appeal that was filed, and a refusal such as an appeal
        // already open (from another tab) means the list on screen is out of date.
        reload();
        return;
      }
      requestKey.current = crypto.randomUUID();
      setText('');
      setNote(t('sent'));
      reload();
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="account-appeals stack" aria-labelledby="account-appeals-title" data-testid="account-appeals">
      <h3 id="account-appeals-title">
        <Copy k="title" />
      </h3>
      <p>
        <Copy k="intro" />
      </p>
      {mine.windowDays === null ? (
        <p data-testid="account-appeals__closed" data-code="identity.appeal_window_unset">
          <Copy k="windowUnset" /> <small lang="zxx">identity.appeal_window_unset</small>
        </p>
      ) : (
        <p>
          <Copy k="windowDays" params={{ days: String(mine.windowDays) }} />
        </p>
      )}
      {appealable && mine.windowDays !== null && !openOne && (
        <form className="stack" onSubmit={(e) => void send(e)} data-testid="account-appeals__form" noValidate>
          <label htmlFor="appeal-text">
            <Copy k="textLabel" />
          </label>
          <textarea
            id="appeal-text"
            name="appeal-text"
            maxLength={APPEAL_TEXT_MAX}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            aria-describedby="appeal-text-hint"
            aria-invalid={empty || undefined}
          />
          <small id="appeal-text-hint">
            <Copy k="textHint" params={{ max: String(APPEAL_TEXT_MAX) }} />
          </small>
          {empty && (
            <p role="alert">
              <Copy k="textEmpty" />
            </p>
          )}
          <button type="submit" className="button" disabled={busy}>
            <Copy k={busy ? 'sending' : 'send'} />
          </button>
        </form>
      )}
      {refusal && (
        <p role="alert" data-testid="account-appeals__refused" data-code={refusal}>
          {REFUSALS.has(refusal) ? t(`refused_${refusal}` as never) : t('refusedOther')} <small lang="zxx">{refusal}</small>
        </p>
      )}
      {note && <p role="status">{note}</p>}
      {mine.appeals.length > 0 && (
        <>
          <h4>
            <Copy k="listTitle" />
          </h4>
          <ul data-testid="account-appeals__list">
            {mine.appeals.map((a) => (
              <li key={a.id} data-testid="account-appeals__appeal" data-status={a.status} data-reason={a.decision?.reason.code ?? ''}>
                <strong>{t(`status_${a.status}`)}</strong> <Copy k="submittedAt" params={{ time: stamp(a.submittedAt, timeZone) }} />{' '}
                {a.decidedAt && <Copy k="decidedAt" params={{ time: stamp(a.decidedAt, timeZone) }} />}
                {a.decision && (
                  <span data-testid="account-appeals__decision">
                    {' '}
                    {a.decision.reason.text ?? t('decisionUnlisted')}{' '}
                    {a.decision.reason.guidance && <Copy k="decisionNext" params={{ guidance: a.decision.reason.guidance }} />}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
