'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { fetchViews, postSupportAction, type ActionReply } from '@/lib/support/browser';
import { VIEW_NAME_MAX } from '@/lib/support/model';
import { FILTER_FIELDS, clauseOf, queueQueryString, type QueueQuery } from '@/lib/support/queue-query';
import type { QueueRefusal, QueueViewRef, SupportViewsView } from '@/lib/support/types';
import { ActionOutcome, Failed } from './support-action-parts';

/**
 * SP-desk-01 — filter, search and saved views over the support queue.
 *
 * The filter and search live in the page address, so a view or a search can be linked and reloaded. svc-support is the
 * judge of a filter: a field it does not have is refused by name above the plain queue, never shown as an empty list.
 * Only the lead shares a view; another agent opens a shared view read-only (svc-support refuses anyone else's change).
 */

const SAVE_REASON = 'Saved from the support queue';

export function refusalSentence(refused: QueueRefusal): string {
  const code = refused.code ? ` (${refused.code})` : '';
  if (refused.what === 'view') return `svc-support could not open that saved view${code}. The list below is the whole queue.`;
  if (refused.what === 'search') return `svc-support refused that search${code}. The list below is the whole queue.`;
  return `svc-support refused the filter on "${refused.field ?? 'that field'}"${code}: the queue has no such field, or not that value. The list below is the whole queue, unfiltered.`;
}

export function QueueFilters({ query, view, refused }: { query: QueueQuery; view: QueueViewRef | null; refused: QueueRefusal | null }) {
  const router = useRouter();
  const shown = view ? null : query.filter;
  const [field, setField] = useState<string>(shown?.field ?? FILTER_FIELDS[0].id);
  const [value, setValue] = useState(shown?.value ?? '');
  const [q, setQ] = useState(query.q);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ActionReply | null>(null);
  const [views, setViews] = useState<SupportViewsView | null>(null);
  const viewsSeq = useRef(0);

  async function reloadViews() {
    const mine = ++viewsSeq.current;
    const next = await fetchViews();
    if (mine === viewsSeq.current) setViews(next);
  }

  useEffect(() => {
    void reloadViews();
  }, []);

  function go(next: QueueQuery) {
    const search = queueQueryString(next);
    router.push(search ? `/support?${search}` : '/support');
  }

  function apply() {
    const v = value.trim();
    go({ viewId: null, filter: v === '' ? null : { field, op: 'eq', value: v }, q: q.trim() });
  }

  async function save() {
    if (busy || !query.filter) return;
    setBusy(true);
    setReply(null);
    try {
      const result = await postSupportAction({
        action: 'view_save',
        name: name.trim(),
        shared: share,
        filter: query.filter,
        reason: SAVE_REASON,
      });
      setReply(result);
      if (result.ok) {
        setSaving(false);
        setName('');
        await reloadViews();
      }
    } finally {
      setBusy(false);
    }
  }

  const counts = views?.counts.kind === 'ok' ? new Map(views.counts.data.map((c) => [c.viewId, c.count])) : null;
  const canSave = query.filter !== null && !view;

  return (
    <div className="dk-stack" data-testid="queue-filters">
      <form
        role="search"
        aria-label="Filter the queue"
        className="dk-row"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="adm-field">
          <label htmlFor="sd-filter-field">Field</label>
          <select id="sd-filter-field" value={field} onChange={(e) => setField(e.target.value)}>
            {FILTER_FIELDS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div className="adm-field">
          <label htmlFor="sd-filter-value">Value</label>
          <input id="sd-filter-value" value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="adm-field">
          <label htmlFor="sd-filter-q">Search requests</label>
          <input id="sd-filter-q" type="search" value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button type="submit" className="adm-btn" data-tone="primary">
          Apply
        </button>
        <button type="button" className="adm-btn" onClick={() => go({ viewId: null, filter: null, q: '' })}>
          Clear
        </button>
        <button type="button" className="adm-btn" disabled={!canSave} onClick={() => setSaving(true)}>
          Save as view
        </button>
        {!canSave && (
          <span className="dk-why">
            {view ? 'This is a saved view already.' : 'Apply a filter first; a view saves the filter applied.'}
          </span>
        )}
      </form>

      {refused && (
        <div className="adm-callout" role="alert" data-tone="danger" data-testid="queue-filter-refused">
          <strong>Filter not applied</strong>
          <p>{refusalSentence(refused)}</p>
        </div>
      )}

      {view && (
        <p className="dk-muted" data-testid="queue-view-open">
          Showing the saved view “{view.name}”{view.shared ? ', shared with the team' : ''}.{' '}
          {view.mine ? 'It is yours.' : 'Someone else made it, so it is read-only here.'}
        </p>
      )}

      {saving && canSave && (
        <div className="adm-callout" data-testid="queue-view-save">
          <strong>Save this filter as a view</strong>
          <div className="adm-field">
            <label htmlFor="sd-view-name">View name</label>
            <input id="sd-view-name" value={name} maxLength={VIEW_NAME_MAX} onChange={(e) => setName(e.target.value)} />
          </div>
          <label className="dk-row" htmlFor="sd-view-share">
            <input id="sd-view-share" type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} />
            Share with the team
          </label>
          <p className="dk-muted">Only a support lead can share a view; svc-support refuses anyone else and says so.</p>
          <div className="dk-row">
            <button type="button" className="adm-btn" data-tone="primary" disabled={busy || name.trim() === ''} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save view'}
            </button>
            <button type="button" className="adm-btn" disabled={busy} onClick={() => setSaving(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <ActionOutcome reply={reply} testId="queue-view-outcome" />

      <nav aria-label="Saved views" className="dk-stack">
        <strong>Saved views</strong>
        {!views && <p className="dk-muted">Reading the saved views…</p>}
        {views && views.list.kind === 'failed' && <Failed name="Saved views" part={views.list} />}
        {views && views.list.kind === 'ok' && views.list.data.views.length === 0 && (
          <p className="dk-muted">svc-support says there are no saved views you can open.</p>
        )}
        {views && views.list.kind === 'ok' && views.list.data.views.length > 0 && (
          <ul className="dk-stack">
            {views.list.data.views.map((v) => {
              const clause = clauseOf(v.filter);
              const count = counts?.get(v.id);
              return (
                <li key={v.id} className="dk-row">
                  <Link href={`/support?view=${v.id}`} aria-current={view?.id === v.id ? 'page' : undefined}>
                    {v.name}
                  </Link>
                  <span className="dk-muted">
                    {count === undefined ? 'count not read' : `${count} matching`} · {v.shared ? 'shared' : 'personal'} ·{' '}
                    {v.ownerId === views.meId ? 'yours' : 'read-only'}
                    {clause ? ` · ${clause.field} is ${clause.value}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
