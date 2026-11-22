import { useMemo, useRef, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { cleanHandle, resolveHandle } from '../../../data/identity';
import { useActivity } from '../../../data/activity';
import { useSession } from '../../session';
import { filterPayees, forgetPayee, identityChanged, readPayees, recentHandles, rememberPayee, type Payee } from '../payees';
import { recipientCopy } from '../recipient-copy';

type Problem = 'notFound' | 'self' | 'rateLimited' | 'unavailable' | 'failed' | 'malformed' | null;

/**
 * The Transfers room's drawing of `RecipientPicker` (../RecipientPicker.tsx, which business people still draws): the
 * same lookups, words and states, in the Volt kit.
 *
 * Pick the person to pay by exact handle, from people remembered on this device, or from people just paid.
 * It never shows or asks for an internal ID: the handle is looked up and the resulting person is handed back.
 */
export function TransferRecipient({ value, onChange }: { value: Payee | null; onChange: (payee: Payee | null) => void }) {
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
      <div>
        <span aria-hidden="true">{value.handle.slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>
            <Copy k="selected" params={{ handle: value.handle }} />
          </strong>
          {userId && (
            <Button
              tone="quiet"
              disabled={remembered || saved.some((row) => row.userId === value.userId)}
              onClick={() => {
                setSaved(rememberPayee(userId, value));
                setRemembered(true);
              }}
            >
              {remembered || saved.some((row) => row.userId === value.userId) ? t('saveDone') : t('save')}
            </Button>
          )}
        </div>
        <Button
          tone="quiet"
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
      <div role="alert">
        <h4>
          <Copy k="changedTitle" />
        </h4>
        <p>
          <Copy k="changedBody" params={{ handle: moved.handle }} />
        </p>
        <div className="lt-actions">
          <Button
            tone="primary"
            onClick={() => {
              if (userId)
                setSaved(forgetPayee(userId, saved.find((row) => row.handle.toLowerCase() === moved.handle.toLowerCase())?.userId ?? ''));
              onChange(moved);
              setMoved(null);
            }}
          >
            <Copy k="changedUse" />
          </Button>
          <Button tone="secondary" onClick={() => setMoved(null)}>
            <Copy k="changedCancel" />
          </Button>
        </div>
      </div>
    );
  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void lookup(text);
        }}
      >
        <Field
          label={t('label')}
          value={text}
          placeholder={t('placeholder')}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={problem !== null}
          {...(problem ? { error: t(problem) } : { hint: t('hint') })}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" tone="secondary" disabled={busy || !text.trim()}>
          {busy ? t('finding') : t('find')}
        </Button>
      </form>
      {shown.length > 0 && (
        <section aria-label={t('saved')}>
          <h4>
            <Copy k="saved" />
          </h4>
          <ul>
            {shown.map((row) => (
              <li key={row.userId}>
                <Button tone="secondary" disabled={busy} onClick={() => void lookup(row.handle)}>
                  @{row.handle}
                </Button>
                <Button
                  tone="quiet"
                  aria-label={t('remove', { handle: row.handle })}
                  onClick={() => userId && setSaved(forgetPayee(userId, row.userId))}
                >
                  ×
                </Button>
              </li>
            ))}
          </ul>
          <small>
            <Copy k="savedNote" />
          </small>
        </section>
      )}
      <section aria-label={t('recent')}>
        <h4>
          <Copy k="recent" />
        </h4>
        {recents.length ? (
          <ul>
            {recents.map((handle) => (
              <li key={handle}>
                <Button tone="secondary" disabled={busy} onClick={() => void lookup(handle)}>
                  @{handle}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <small>
            <Copy k="recentNone" />
          </small>
        )}
      </section>
    </div>
  );
}
