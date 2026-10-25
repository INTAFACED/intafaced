'use client';

import { useCallback, useState } from 'react';
import { Chip } from '@/components/chip';
import './desk.css';
import { formatAsOf, formatWhen } from '@/lib/as-of';
import { fetchItemRules, postItemRulesChange } from '@/lib/academy/item-rules-browser';
import type { AcademyCourseItemRules, ItemRulesDeskReply, ItemRulesView } from '@/lib/academy/item-rules-model';
import { Failed, Outcome } from '@/components/academy-courses-desk';

/**
 * PREREQUISITES AND DUE DATES (AC-release-access-02).
 *
 * Each assignment and quiz may require other assignments or quizzes of the course; a learner meets one by handing it in,
 * finishing an attempt or answering it. A lesson, video, file or link records no completion here, so it is not offered.
 * A set that would make an item require itself, directly or through others, is refused by name and nothing is saved.
 * One learner's due date on an assignment can move later, with a reason; the list shows who granted each and why. This
 * section shows every refusal and reads again, never retrying on its own.
 */

type Item = AcademyCourseItemRules['items'][number];

function PrerequisiteForm({
  item,
  items,
  busy,
  onSave,
}: {
  item: Item;
  items: readonly Item[];
  busy: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [chosen, setChosen] = useState<string[]>(item.prerequisites);
  const [reason, setReason] = useState('');
  const titleOf = (id: string) => items.find((i) => i.itemId === id)?.title ?? id;
  return (
    <li className="dk-stack" data-testid="item-prerequisites" data-item={item.title}>
      <strong>
        {item.title} <span className="dk-muted">({item.kind})</span>
      </strong>
      <span className="dk-muted" data-testid="prerequisites-now">
        {item.prerequisites.length === 0 ? 'Requires nothing' : `Requires ${item.prerequisites.map(titleOf).join(', ')}`}
        {item.setAt && ` · set ${formatWhen(item.setAt)}${item.reason ? `: ${item.reason}` : ''}`}
      </span>
      <form
        className="dk-stack"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ itemId: item.itemId, prerequisiteIds: chosen, reason });
        }}
      >
        <fieldset className="dk-row">
          <legend>Requires</legend>
          {items
            .filter((other) => other.itemId !== item.itemId)
            .map((other) => (
              <label key={other.itemId}>
                <input
                  type="checkbox"
                  checked={chosen.includes(other.itemId)}
                  onChange={(e) =>
                    setChosen((now) => (e.target.checked ? [...now, other.itemId] : now.filter((id) => id !== other.itemId)))
                  }
                  aria-label={`${item.title} requires ${other.title}`}
                />{' '}
                {other.title}
              </label>
            ))}
        </fieldset>
        <div className="dk-row">
          <label>
            Reason
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              aria-label={`Prerequisites reason, ${item.title}`}
            />
          </label>
          <button type="submit" className="adm-btn" disabled={busy}>
            Save prerequisites
          </button>
        </div>
      </form>
    </li>
  );
}

function ExtensionForm({
  assignments,
  busy,
  onGrant,
}: {
  assignments: readonly Item[];
  busy: boolean;
  onGrant: (body: Record<string, unknown>) => void;
}) {
  const [itemId, setItemId] = useState(assignments[0]?.itemId ?? '');
  const [userId, setUserId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [reason, setReason] = useState('');
  const due = assignments.find((a) => a.itemId === itemId)?.dueAt ?? null;
  return (
    <form
      className="dk-row"
      data-testid="extension-form"
      onSubmit={(e) => {
        e.preventDefault();
        // An unreadable date is sent as it is, so the form names the mistake rather than guessing an instant.
        const instant = new Date(dueAt);
        onGrant({ itemId, userId: userId.trim(), dueAt: Number.isNaN(instant.getTime()) ? dueAt : instant.toISOString(), reason });
      }}
    >
      <label>
        Assignment
        <select value={itemId} onChange={(e) => setItemId(e.target.value)} aria-label="Extension assignment">
          {assignments.map((a) => (
            <option key={a.itemId} value={a.itemId}>
              {a.title}
            </option>
          ))}
        </select>
      </label>
      <span className="dk-muted">{due ? `Due for everyone ${formatWhen(due)}` : 'This assignment has no due date to move.'}</span>
      <label>
        Learner account id
        <input value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Learner account id" />
      </label>
      <label>
        New due date (your time)
        <input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} aria-label="New due date" />
      </label>
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} aria-label="Extension reason" />
      </label>
      <button type="submit" className="adm-btn" disabled={busy}>
        Move the due date
      </button>
    </form>
  );
}

export function AcademyCourseItemRules({ courseId, initial }: { courseId: string; initial: ItemRulesView | null }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ItemRulesDeskReply | null>(null);

  const reload = useCallback(async () => {
    const next = await fetchItemRules(courseId);
    if (next) setView(next);
  }, [courseId]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const answer = await postItemRulesChange({ courseId, ...body });
    setReply(answer);
    setBusy(false);
    // Whatever the answer, the section shows the course as svc-academy holds it now.
    await reload();
  };

  const part = view?.rules;
  const rules = part?.kind === 'ok' ? part.data : null;
  const assignments = rules?.items.filter((i) => i.kind === 'assignment') ?? [];
  const titleOf = (id: string) => rules?.items.find((i) => i.itemId === id)?.title ?? id;
  return (
    <section className="dk-stack" aria-labelledby="h-item-rules" data-testid="course-item-rules">
      <h2 id="h-item-rules">Prerequisites and due dates</h2>
      <span className="dk-asof">{view ? `Read ${formatAsOf(view.asOf)}` : 'No read yet'}</span>
      <Outcome reply={reply} />
      {!part && <p className="dk-why">The console could not reach its own server for this course. Nothing is shown rather than a guess.</p>}
      {part?.kind === 'failed' && <Failed title="Could not read prerequisites and due dates" message={part.message} code={part.code} />}
      {rules && (
        <>
          {rules.items.length === 0 ? (
            <p className="dk-muted">The outline has no assignment or quiz yet, so nothing can be required.</p>
          ) : (
            <ol className="dk-stack" aria-label="Prerequisites">
              {rules.items.map((item) => (
                <PrerequisiteForm
                  key={`${item.itemId}-${item.setAt}`}
                  item={item}
                  items={rules.items}
                  busy={busy}
                  onSave={(b) => void send({ op: 'setPrerequisites', ...b })}
                />
              ))}
            </ol>
          )}
          <h3>Learners&rsquo; own due dates</h3>
          {assignments.length === 0 ? (
            <p className="dk-muted">The outline has no assignment yet.</p>
          ) : (
            <ExtensionForm assignments={assignments} busy={busy} onGrant={(b) => void send({ op: 'grantExtension', ...b })} />
          )}
          {rules.extensions.length === 0 ? (
            <p className="dk-muted" data-testid="extensions-empty">
              No learner has a due date of their own.
            </p>
          ) : (
            <div className="dk-table-wrap">
              <table className="adm-table" data-testid="extensions">
                <thead>
                  <tr>
                    <th>Assignment</th>
                    <th>Learner</th>
                    <th>Due</th>
                    <th>Granted by</th>
                    <th>Why</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.extensions.map((x) => (
                    <tr key={`${x.itemId}-${x.userId}`} data-learner={x.userId}>
                      <td>{titleOf(x.itemId)}</td>
                      <td>
                        <code>{x.userId}</code>
                      </td>
                      <td>{formatWhen(x.dueAt)}</td>
                      <td>
                        <Chip tone="neutral">{x.grantedBy}</Chip> {formatWhen(x.grantedAt)}
                      </td>
                      <td>{x.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
