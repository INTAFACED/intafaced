import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button, refusalCopy, type ActivityItem } from './deps';
import { moneyCopy } from './copy';
import { NOTE_MAX, noteProblem, type NoteProblem } from './note-model';
import { useSession } from '../../features/session/session';

const savedShape = z.object({ activityId: z.string(), text: z.string(), updatedAt: z.string() });

const PROBLEM_KEY = {
  empty: 'Note empty',
  tooLong: 'Note too long',
  control: 'Note one line',
  unchanged: 'Note unchanged',
} as const satisfies Record<NoteProblem, string>;

/**
 * The customer's own note on one activity line: private, one line, up to 500 characters. One command id per save
 * attempt, reused when the same text is sent again after a failure, so a retry can never write twice; a changed text
 * starts a new attempt.
 */
export function ActivityNote({ item }: { item: ActivityItem }) {
  const { t } = moneyCopy.useCopy();
  const { api } = useSession();
  const [saved, setSaved] = useState<string | undefined>(item.privateNote);
  const [text, setText] = useState(item.privateNote ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; words: string } | null>(null);
  const attempt = useRef<{ text: string; commandId: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const problem = noteProblem(text, saved);
  const shown = problem && problem !== 'unchanged' && text.length > 0 ? t(PROBLEM_KEY[problem]) : null;

  async function save() {
    const next = text.trim();
    if (busy || problem !== null || !api.canWrite()) return;
    if (attempt.current?.text !== next) attempt.current = { text: next, commandId: `note-${crypto.randomUUID()}` };
    setBusy(true);
    setMessage(null);
    const result = await api.mutate(
      'bank',
      'activity.note.set',
      { id: item.id, text: next, commandId: attempt.current.commandId },
      savedShape,
    );
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      attempt.current = null;
      setSaved(result.data.text);
      setText(result.data.text);
      setMessage({ tone: 'ok', words: t('Note saved') });
    } else {
      setMessage({
        tone: 'error',
        words: result.reason === 'uncertain' ? t('Note unsure') : refusalCopy(result.code ?? result.reason).title,
      });
    }
  }

  return (
    <form
      className="money-note-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="money-note-form__label" htmlFor={`note-${item.id}`}>
        {t('Your note')}
      </label>
      <p className="money-detail__note">{t('Your note hint')}</p>
      <div className="money-note-form__row">
        <input
          id={`note-${item.id}`}
          className="money-note-form__input"
          type="text"
          value={text}
          maxLength={NOTE_MAX}
          autoComplete="off"
          aria-invalid={shown ? true : undefined}
          aria-describedby={`note-state-${item.id}`}
          onChange={(event) => {
            setText(event.target.value);
            setMessage(null);
          }}
        />
        <Button type="submit" variant="secondary" size={40} disabled={busy || problem !== null}>
          {saved === undefined ? t('Add a note') : t('Save note')}
        </Button>
      </div>
      <p id={`note-state-${item.id}`} className="money-detail__note" role="status">
        {shown ?? message?.words ?? ''}
      </p>
    </form>
  );
}
