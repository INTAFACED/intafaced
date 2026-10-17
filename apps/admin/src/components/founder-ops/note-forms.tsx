'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { StateBlock } from '@/components/merchants/ui';
import { NOTE_BODY_MAX, parseTags, RETRACT_REASON_MAX, RETRACT_REASON_MIN } from '@/lib/founder-ops/notes';
import { postNotes, type NotesReply } from '@/lib/founder-ops/notes-client';

/** Add a note. The text is saved as typed; the author is the signed-in founder, recorded by the service, not by this form. */
export function AddNoteForm({ merchantId }: { merchantId: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Extract<NotesReply, { ok: false }> | null>(null);
  const parsed = parseTags(tags);
  const why =
    body.trim().length === 0
      ? 'Write the note first.'
      : body.trim().length > NOTE_BODY_MAX
        ? `The note is too long (at most ${NOTE_BODY_MAX} characters).`
        : parsed === null
          ? 'Too many tags, or a tag is too long (20 tags, 40 characters each).'
          : busy
            ? 'Saving.'
            : null;
  async function submit() {
    if (why !== null || parsed === null) return;
    setBusy(true);
    setProblem(null);
    const reply = await postNotes({ action: 'add', merchantId, body: body.trim(), tags: parsed, flagged });
    setBusy(false);
    if (reply.ok) {
      setBody('');
      setTags('');
      setFlagged(false);
      router.refresh();
    } else setProblem(reply);
  }
  return (
    <form
      className="mp-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="mp-field">
        <label htmlFor="note-body">New note (founders only, never shown to the merchant)</label>
        <textarea
          id="note-body"
          className="mp-input"
          rows={3}
          maxLength={NOTE_BODY_MAX + 1}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
        />
        <span className="mp-hint">
          {body.trim().length} of {NOTE_BODY_MAX} characters. Notes cannot be edited; a wrong note is retracted and the history keeps it.
        </span>
      </div>
      <div className="mp-field">
        <label htmlFor="note-tags">Tags (optional, separated by commas)</label>
        <input id="note-tags" className="mp-input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <label className="mp-inline">
        <input type="checkbox" checked={flagged} onChange={(e) => setFlagged(e.target.checked)} /> Flag this merchant for watching
      </label>
      {problem ? (
        <StateBlock kind="error" title={problem.title}>
          {problem.body} {problem.next}
        </StateBlock>
      ) : null}
      <span title={why ?? undefined}>
        <button type="submit" className="mp-btn mp-btn--primary" disabled={why !== null}>
          {busy ? 'Saving…' : 'Add note'}
        </button>
      </span>
    </form>
  );
}

/** Retract one note with a reason. The note and the reason both stay in the history. */
export function RetractNoteForm({ noteId }: { noteId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Extract<NotesReply, { ok: false }> | null>(null);
  const trimmed = reason.trim();
  const why =
    trimmed.length < RETRACT_REASON_MIN
      ? `Say why (at least ${RETRACT_REASON_MIN} characters).`
      : trimmed.length > RETRACT_REASON_MAX
        ? `The reason is too long (at most ${RETRACT_REASON_MAX}).`
        : busy
          ? 'Saving.'
          : null;
  if (!open)
    return (
      <button type="button" className="mp-btn mp-btn--small" onClick={() => setOpen(true)}>
        Retract
      </button>
    );
  return (
    <form
      className="mp-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (why !== null) return;
        setBusy(true);
        setProblem(null);
        const reply = await postNotes({ action: 'retract', noteId, reason: trimmed });
        setBusy(false);
        if (reply.ok) router.refresh();
        else setProblem(reply);
      }}
    >
      <label className="mp-field">
        Reason for retracting
        <input
          className="mp-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={RETRACT_REASON_MAX + 1}
          required
        />
      </label>
      {problem ? (
        <StateBlock kind="error" title={problem.title}>
          {problem.body} {problem.next}
        </StateBlock>
      ) : null}
      <span className="mp-inline">
        <span title={why ?? undefined}>
          <button type="submit" className="mp-btn mp-btn--small" disabled={why !== null}>
            {busy ? 'Saving…' : 'Confirm retract'}
          </button>
        </span>
        <button type="button" className="mp-btn mp-btn--small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </span>
    </form>
  );
}
