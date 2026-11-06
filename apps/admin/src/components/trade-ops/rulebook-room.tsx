'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { ActionApproval } from '@intafaced/contracts';
import { PageSection } from './kit';
import { OutcomeNotice } from './outcome-notice';
import { tradeOpsAction } from '@/lib/trade-ops/client';
import type { Outcome } from '@/lib/trade-ops/outcome';
import type { RulebookDeskView } from '@/lib/trade-ops/rulebook-calls';
import { RULEBOOK_SECTIONS, rulebookTime, type RulebookDraft, type RulebookPublished } from '@/lib/trade-ops/rulebook-model';

/**
 * Trading rulebook (RC-cex-spot-08, J-cex-spot-20 #6): the version in force and every published version, and the form
 * for a new one. svc-matching checks the draft (every section is owner text; a blank one is refused by its code), a second
 * founder approves the request, then this founder publishes it. A published version never changes. Bodies are plain text.
 */

interface Filed {
  readonly approval: ActionApproval;
  readonly payloadHash: string;
  readonly version: string;
}

const emptyDraft = (): RulebookDraft => ({
  version: '',
  effectiveAt: '',
  sections: Object.fromEntries(RULEBOOK_SECTIONS.map((s) => [s.id, ''])),
});

export function RulebookRoom({ initial }: { initial: RulebookDeskView }) {
  const history = initial.history;
  const router = useRouter();
  const [draft, setDraft] = useState<RulebookDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [proposed, setProposed] = useState<Outcome<Filed> | null>(null);
  const [filed, setFiled] = useState<{ draft: RulebookDraft; filed: Filed } | null>(null);
  const [published, setPublished] = useState<Outcome<RulebookPublished> | null>(null);

  const setSection = (id: string, body: string) => setDraft((d) => ({ ...d, sections: { ...d.sections, [id]: body } }));

  async function propose() {
    setBusy(true);
    setPublished(null);
    const sent = draft;
    const o = await tradeOpsAction<Filed>('rulebook', { action: 'propose', draft: sent });
    setProposed(o);
    // The request binds exactly this text: publishing sends the same draft, whatever the form shows later.
    setFiled(o.kind === 'ok' ? { draft: sent, filed: o.data } : null);
    setBusy(false);
  }

  async function publish() {
    if (!filed) return;
    setBusy(true);
    const o = await tradeOpsAction<RulebookPublished>('rulebook', {
      action: 'publish',
      draft: filed.draft,
      approvalId: filed.filed.approval.approvalId,
    });
    setPublished(o);
    if (o.kind === 'ok') {
      // The request is spent: clear it, and read the versions again so "In force" and the history show the new one.
      setFiled(null);
      setProposed(null);
      setDraft(emptyDraft());
      router.refresh();
    }
    setBusy(false);
  }

  const current = history.kind === 'ok' ? (history.data.versions.find((v) => v.status === 'current') ?? null) : null;

  return (
    <div className="flex flex-col gap-6" data-room="rulebook">
      <PageSection title="In force">
        {history.kind !== 'ok' ? (
          <OutcomeNotice outcome={history} />
        ) : current === null ? (
          <p className="text-sm text-fg-2">No version is in force: customers see that no rulebook is published.</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <p>
              Version <strong data-current-version>{current.version}</strong>, in force since {rulebookTime(current.effectiveAt)}.{' '}
              <a className="underline" href="/rulebook">
                Customers read it at /rulebook
              </a>
              .
            </p>
          </div>
        )}
      </PageSection>

      <PageSection title="Version history">
        {history.kind === 'ok' ? (
          history.data.versions.length === 0 ? (
            <p className="text-sm text-fg-2" data-history>
              No version has been published.
            </p>
          ) : (
            <ol className="flex flex-col gap-2 text-sm" data-history>
              {history.data.versions.map((v) => (
                <li key={v.version} data-version={v.version} data-status={v.status} className="flex flex-col gap-1">
                  <span>
                    <strong>{v.version}</strong> ·{' '}
                    {v.status === 'current'
                      ? 'in force'
                      : v.status === 'upcoming'
                        ? `takes effect ${rulebookTime(v.effectiveAt)}`
                        : 'replaced'}{' '}
                    · published {rulebookTime(v.publishedAt)}
                  </span>
                  <span className="text-fg-2">
                    {v.supersedes === null
                      ? 'First version: every section'
                      : `Replaces ${v.supersedes}; changed: ${v.changedSections.join(', ') || 'none'}`}
                  </span>
                </li>
              ))}
            </ol>
          )
        ) : null}
      </PageSection>

      <PageSection title="New version">
        <form
          aria-label="Publish a rulebook version"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void propose();
          }}
        >
          <p className="text-sm text-fg-2">
            Write every section in the owner&apos;s words. A section left blank is refused, and a published version id never takes new text:
            publish the change under a new id.
          </p>
          <label className="flex flex-col gap-1 text-sm">
            <span>Version</span>
            <input className="adm-input" value={draft.version} onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span>Takes effect at (UTC, ISO time; blank: when published)</span>
            <input
              className="adm-input"
              placeholder="2026-12-01T00:00:00Z"
              value={draft.effectiveAt}
              onChange={(e) => setDraft((d) => ({ ...d, effectiveAt: e.target.value }))}
            />
          </label>
          {RULEBOOK_SECTIONS.map((s) => (
            <label key={s.id} className="flex flex-col gap-1 text-sm">
              <span>Section: {s.title}</span>
              <textarea
                className="adm-input"
                rows={3}
                value={draft.sections[s.id] ?? ''}
                onChange={(e) => setSection(s.id, e.target.value)}
              />
            </label>
          ))}
          <div>
            <button type="submit" className="adm-btn" data-tone="primary" disabled={busy}>
              Propose version
            </button>
          </div>
        </form>

        {proposed ? (
          <div className="mt-3 flex flex-col gap-2">
            <OutcomeNotice outcome={proposed} doneText="Request filed" />
            {proposed.kind === 'ok' ? (
              <div data-filed className="flex flex-col gap-2">
                <dl data-filed="request" className="grid gap-x-4 gap-y-1 text-sm md:grid-cols-[max-content_1fr]">
                  <dt className="text-fg-2">Version</dt>
                  <dd className="if-num">{proposed.data.version}</dd>
                  <dt className="text-fg-2">Approval id</dt>
                  <dd className="if-num" data-field="Approval id">
                    {proposed.data.approval.approvalId}
                  </dd>
                  <dt className="text-fg-2">Payload hash</dt>
                  <dd className="if-num break-all" data-field="Payload hash">
                    {proposed.data.payloadHash}
                  </dd>
                </dl>
                <p className="text-sm text-fg-2">
                  A second founder approves this request in Freezes &amp; approvals with the id and the hash. Then publish it here.
                </p>
                <div>
                  <button type="button" className="adm-btn" data-tone="primary" disabled={busy} onClick={() => void publish()}>
                    Publish approved version
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {published ? (
          <div className="mt-3 flex flex-col gap-1">
            <OutcomeNotice outcome={published} doneText="Published" />
            {published.kind === 'ok' ? (
              <p className="text-sm">
                Version <strong data-published-version>{published.data.version}</strong>{' '}
                {published.data.alreadyPublished ? 'was already published with this text.' : 'is published.'}
              </p>
            ) : null}
          </div>
        ) : null}
      </PageSection>
    </div>
  );
}
