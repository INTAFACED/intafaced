import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button, refusalCopy, type ActivityItem } from './deps';
import { moneyCopy } from './copy';
import { NOTE_MAX, noteProblem, type NoteProblem } from './note-model';
import { useSession } from '../../features/session/session';

const savedShape = z.object({
  activityId: z.string(),
  text: z.string().nullable(),
  reportDescription: z.string().nullable().optional(),
  updatedAt: z.string(),
});

/** The two lines of words a customer can keep on an activity line: a private note, and a description for their reports. */
const FIELDS = {
  note: {
    wire: 'text',
    label: 'Your note',
    hint: 'Your note hint',
    add: 'Add a note',
    save: 'Save note',
    saved: 'Note saved',
    unsure: 'Note unsure',
  },
  description: {
    wire: 'reportDescription',
    label: 'Report description',
    hint: 'Report description hint',
    add: 'Add a description',
    save: 'Save description',
    saved: 'Description saved',
    unsure: 'Description unsure',
  },
} as const;

const PROBLEM_KEY = {
  empty: 'Note empty',
  tooLong: 'Note too long',
  control: 'Note one line',
  unchanged: 'Note unchanged',
} as const satisfies Record<NoteProblem, string>;

/**
 * One line of the customer's own words on an activity line: private, one line, up to 500 characters. One command id per
 * save attempt, reused when the same text is sent again after a failure, so a retry can never write twice; a changed
 * text starts a new attempt. Each field is saved on its own and leaves the other as it was.
 */
function WordsField({ item, field, initial }: { item: ActivityItem; field: keyof typeof FIELDS; initial: string | undefined }) {
  const { t } = moneyCopy.useCopy();
  const { api } = useSession();
  const names = FIELDS[field];
  const [saved, setSaved] = useState<string | undefined>(initial);
  const [text, setText] = useState(initial ?? '');
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
  const inputId = `${field}-${item.id}`;

  async function save() {
    const next = text.trim();
    if (busy || problem !== null || !api.canWrite()) return;
    if (attempt.current?.text !== next) attempt.current = { text: next, commandId: `note-${crypto.randomUUID()}` };
    setBusy(true);
    setMessage(null);
    const result = await api.mutate(
      'bank',
      'activity.note.set',
      { id: item.id, [names.wire]: next, commandId: attempt.current.commandId },
      savedShape,
    );
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      attempt.current = null;
      const stored = (field === 'note' ? result.data.text : result.data.reportDescription) ?? next;
      setSaved(stored);
      setText(stored);
      setMessage({ tone: 'ok', words: t(names.saved) });
    } else {
      setMessage({
        tone: 'error',
        words: result.reason === 'uncertain' ? t(names.unsure) : refusalCopy(result.code ?? result.reason).title,
      });
    }
  }

  return (
    <form
      data-testid="money-note-form"
      className="money-note-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="money-note-form__label" htmlFor={inputId}>
        {t(names.label)}
      </label>
      <p className="money-detail__note">{t(names.hint)}</p>
      <div className="money-note-form__row">
        <input
          id={inputId}
          className="money-note-form__input"
          type="text"
          value={text}
          maxLength={NOTE_MAX}
          autoComplete="off"
          aria-invalid={shown ? true : undefined}
          aria-describedby={`${field}-state-${item.id}`}
          onChange={(event) => {
            setText(event.target.value);
            setMessage(null);
          }}
        />
        <Button type="submit" variant="secondary" size={40} disabled={busy || problem !== null}>
          {saved === undefined ? t(names.add) : t(names.save)}
        </Button>
      </div>
      <p id={`${field}-state-${item.id}`} className="money-detail__note" role="status">
        {shown ?? message?.words ?? ''}
      </p>
    </form>
  );
}

/** The private note and the description for reports on one activity line. */
export function ActivityNote({ item }: { item: ActivityItem }) {
  return (
    <>
      <WordsField item={item} field="note" initial={item.privateNote} />
      <WordsField item={item} field="description" initial={item.reportDescription} />
    </>
  );
}
