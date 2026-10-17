import { useMemo, useRef, useState } from 'react';
import { Button } from '../../shared/ui';
import { cleanHandle, resolveHandle } from '../../data/identity';
import { useActivity } from '../../data/activity';
import { useSession } from '../session/session';
import { filterPayees, forgetPayee, identityChanged, readPayees, recentHandles, rememberPayee, type Payee } from './payees';
import { recipientCopy } from './recipient-copy';
import './bank-depth.css';

type Problem = 'notFound' | 'self' | 'rateLimited' | 'unavailable' | 'failed' | 'malformed' | null;

/**
 * Pick the person to pay by exact handle, from people remembered on this device, or from people just paid.
 * It never shows or asks for an internal ID: the handle is looked up and the resulting person is handed back.
 */
export function RecipientPicker({ value, onChange }: { value: Payee | null; onChange: (payee: Payee | null) => void }) {
  const { Copy, t } = recipientCopy.useCopy();
  const { api, userId } = useSession();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [saved, setSaved] = useState<Payee[]>(() => (userId ? readPayees(userId) : []));
  const [remembered, setRemembered] = useState(false);
  const [moved, setMoved] = useState<Payee | null>(null);
  const run = useRef(0);
  const activity = useActivity({ pageSize: 100 });
  const recents = useMemo(
    () => (activity.status === 'ready' ? recentHandles(activity.data.items) : []),
    [activity.status === 'ready' ? activity.data.items : null],
  );

  async function lookup(raw: string) {
    const clean = cleanHandle(raw);
    if (!clean) {
      setProblem('malformed');
      return;
    }
    const mine = ++run.current;
    setBusy(true);
    setProblem(null);
    const outcome = await resolveHandle(api, clean);
    if (run.current !== mine) return;
    setBusy(false);
    if (outcome.kind === 'found') {
      if (outcome.self) {
        setProblem('self');
        return;
      }
      setRemembered(false);
      const found = { userId: outcome.userId.toLowerCase(), handle: outcome.handle };
      // A saved handle can be released and taken by someone else. Never switch the payee silently.
      if (
        identityChanged(
          saved.find((row) => row.handle.toLowerCase() === clean.toLowerCase()),
          found.userId,
        )
      ) {
        setMoved(found);
        return;
      }
      onChange(found);
      return;
    }
    setProblem(outcome.kind);
  }

  if (value)
    return (
      <div className="bd-recipient bd-recipient--chosen">
        <span className="bd-avatar" aria-hidden="true">
          {value.handle.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <strong>
            <Copy k="selected" params={{ handle: value.handle }} />
          </strong>
          {userId && (
            <button
              type="button"
              className="bd-link"
              disabled={remembered || saved.some((row) => row.userId === value.userId)}
              onClick={() => {
                setSaved(rememberPayee(userId, value));
                setRemembered(true);
              }}
            >
              {remembered || saved.some((row) => row.userId === value.userId) ? t('saveDone') : t('save')}
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setText('');
            onChange(null);
          }}
        >
          <Copy k="change" />
        </Button>
      </div>
    );

  const shown = filterPayees(saved, text);
  if (moved)
    return (
      <div className="bd-recipient" role="alert">
        <h4 className="bd-subhead">
          <Copy k="changedTitle" />
        </h4>
        <p>
          <Copy k="changedBody" params={{ handle: moved.handle }} />
        </p>
        <div className="actions">
          <Button
            onClick={() => {
              if (userId)
                setSaved(forgetPayee(userId, saved.find((row) => row.handle.toLowerCase() === moved.handle.toLowerCase())?.userId ?? ''));
              onChange(moved);
              setMoved(null);
            }}
          >
            <Copy k="changedUse" />
          </Button>
          <Button variant="secondary" onClick={() => setMoved(null)}>
            <Copy k="changedCancel" />
          </Button>
        </div>
      </div>
    );
  return (
    <div className="bd-recipient">
      <form
        className="bd-recipient__search"
        onSubmit={(event) => {
          event.preventDefault();
          void lookup(text);
        }}
      >
        <label className="field">
          <span>
            <Copy k="label" />
          </span>
          <input
            value={text}
            placeholder={t('placeholder')}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={problem !== null}
            aria-describedby="bd-recipient-help"
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
          />
          <small id="bd-recipient-help" className={problem ? 'error-text' : ''} role={problem ? 'alert' : undefined}>
            {problem ? t(problem) : t('hint')}
          </small>
        </label>
        <Button type="submit" variant="secondary" disabled={busy || !text.trim()}>
          {busy ? t('finding') : t('find')}
        </Button>
      </form>
      {shown.length > 0 && (
        <section aria-label={t('saved')}>
          <h4 className="bd-subhead">
            <Copy k="saved" />
          </h4>
          <ul className="bd-chips">
            {shown.map((row) => (
              <li key={row.userId}>
                <button type="button" className="bd-chip" disabled={busy} onClick={() => void lookup(row.handle)}>
                  @{row.handle}
                </button>
                <button
                  type="button"
                  className="bd-chip-x"
                  aria-label={t('remove', { handle: row.handle })}
                  onClick={() => userId && setSaved(forgetPayee(userId, row.userId))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          <small className="money-caption">
            <Copy k="savedNote" />
          </small>
        </section>
      )}
      <section aria-label={t('recent')}>
        <h4 className="bd-subhead">
          <Copy k="recent" />
        </h4>
        {recents.length ? (
          <ul className="bd-chips">
            {recents.map((handle) => (
              <li key={handle}>
                <button type="button" className="bd-chip" disabled={busy} onClick={() => void lookup(handle)}>
                  @{handle}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <small className="money-caption">
            <Copy k="recentNone" />
          </small>
        )}
      </section>
    </div>
  );
}
