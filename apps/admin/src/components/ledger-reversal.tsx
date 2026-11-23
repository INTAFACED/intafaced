'use client';

import { useState, type FormEvent } from 'react';
import { ControlDesk } from '@/components/control-desk';
import { formatWhen } from '@/lib/as-of';
import { founderMutationHeaders } from '@/lib/founder-browser';
import { useResource } from '@/lib/hooks/use-resource';
import type { RefusalView } from '@/lib/refusal-copy';
import { firstReversalOf, reversalAsk, reversalStateWords, type FirstReversal, type OpsLedgerReversal } from '@/lib/ledger-reversals/model';

export type ListView =
  | { readonly kind: 'reading' }
  | { readonly kind: 'ok'; readonly reversals: readonly OpsLedgerReversal[]; readonly writes: RefusalView | null; readonly asOf: string }
  | { readonly kind: 'refused'; readonly refusal: RefusalView | null };

export type AskView =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'asked'; readonly reversal: OpsLedgerReversal }
  | { readonly kind: 'refused'; readonly refusal: RefusalView; readonly firstReversal: FirstReversal | null };

const UNREADABLE: RefusalView = {
  title: 'The console did not answer',
  body: 'The request did not come back, so it is not known whether svc-ops wrote it.',
  next: 'Read the reversal requests again before asking again.',
  code: null,
  changed: 'unknown',
};

const READING: ListView = { kind: 'reading' };
const NO_ANSWER: ListView = { kind: 'refused', refusal: null };

/** One read of the reversal requests for a transaction. It never throws: no answer is a refusal with no code. */
async function loadList(txId: string, signal: AbortSignal): Promise<ListView> {
  try {
    const res = await fetch(`/api/ledger-reversals?txId=${encodeURIComponent(txId)}`, { cache: 'no-store', signal });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      list?: { reversals: OpsLedgerReversal[]; asOf: string };
      writes?: RefusalView | null;
      refusal?: RefusalView | null;
    } | null;
    if (!res.ok || !body?.ok || !body.list) return { kind: 'refused', refusal: body?.refusal ?? null };
    return { kind: 'ok', reversals: body.list.reversals, writes: body.writes ?? null, asOf: body.list.asOf };
  } catch {
    return NO_ANSWER;
  }
}

/**
 * Reverse one posted ledger transaction (OPS-ledger-desk-02, J-ops-console-05 #1-#3).
 *
 * The founder who holds the treasury credential presses Reverse with a reason and a case reference: svc-ops writes the intent
 * row, and nothing posts. That founder then asks a different founder to approve exactly that request (the packet); the other
 * founder approves on their own console; the first runs it, and the ledger books one linked compensating transaction from the
 * stored original. Each request shows where it stands as svc-ops stores it. A second reversal of the same transaction is
 * refused `ops.reversal_already_reversed`, with the first reversal shown.
 */
export function LedgerReversal({
  txId,
  userId,
  onFollow,
  onChanged,
}: {
  txId: string;
  userId: string;
  /** Open another transaction in the lookup (the first or the reversing one). */
  onFollow?: (txId: string) => void;
  /** Read the transaction again once a reversal has posted, so it shows who reversed it. */
  onChanged?: () => void;
}) {
  const { resource, reload } = useResource((signal) => loadList(txId, signal), `ledger-reversals:${txId}`);
  // While a read runs again, the last answer stays on screen, so an open request (and its approval desk) is not unmounted.
  const [kept, setKept] = useState<ListView>(READING);
  const fresh: ListView = resource.status === 'ready' ? resource.data : resource.status === 'failed' ? NO_ANSWER : READING;
  if (fresh !== READING && fresh !== kept) setKept(fresh);
  const list = fresh === READING ? kept : fresh;
  const [reason, setReason] = useState('');
  const [caseRef, setCaseRef] = useState('');
  const [ask, setAsk] = useState<AskView>({ kind: 'idle' });

  const checked = reversalAsk(reason, caseRef);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!checked.ok || ask.kind === 'sending') return;
    setAsk({ kind: 'sending' });
    try {
      const res = await fetch('/api/ledger-reversals', {
        method: 'POST',
        headers: await founderMutationHeaders(),
        body: JSON.stringify({ txId, reason: checked.reason, caseRef: checked.caseRef }),
        cache: 'no-store',
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => null)) as
        { ok: true; reversal: OpsLedgerReversal } | { ok: false; refusal?: RefusalView; firstReversal?: FirstReversal | null } | null;
      if (body?.ok) {
        setAsk({ kind: 'asked', reversal: body.reversal });
        setReason('');
        setCaseRef('');
      } else
        setAsk({
          kind: 'refused',
          refusal: body?.refusal ?? UNREADABLE,
          firstReversal: body && !body.ok ? (body.firstReversal ?? null) : null,
        });
    } catch {
      setAsk({ kind: 'refused', refusal: UNREADABLE, firstReversal: null });
    }
    reload();
  };

  return (
    <LedgerReversalView
      txId={txId}
      userId={userId}
      list={list}
      ask={ask}
      reason={reason}
      caseRef={caseRef}
      onReason={setReason}
      onCaseRef={setCaseRef}
      onSubmit={(event) => void submit(event)}
      onRequestChanged={() => {
        reload();
        onChanged?.();
      }}
      {...(onFollow ? { onFollow } : {})}
    />
  );
}

export interface LedgerReversalViewProps {
  readonly txId: string;
  readonly userId: string;
  readonly list: ListView;
  readonly ask: AskView;
  readonly reason: string;
  readonly caseRef: string;
  readonly onReason: (value: string) => void;
  readonly onCaseRef: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly onRequestChanged: () => void;
  readonly onFollow?: (txId: string) => void;
}

/** The reversal control in each state it can hold, with no fetching of its own. */
export function LedgerReversalView({
  txId,
  userId,
  list,
  ask,
  reason,
  caseRef,
  onReason,
  onCaseRef,
  onSubmit,
  onRequestChanged,
  onFollow,
}: LedgerReversalViewProps) {
  const checked = reversalAsk(reason, caseRef);
  const writes = list.kind === 'ok' ? list.writes : null;
  const first = list.kind === 'ok' ? firstReversalOf(list.reversals) : null;

  return (
    <section className="adm-control-card" data-testid="tx-reversal" aria-labelledby={`tx-reversal-${txId}`}>
      <h3 id={`tx-reversal-${txId}`}>Reverse this transaction</h3>
      <p className="adm-subtle">
        A reversal books one linked compensating transaction built by the ledger from this one: every leg flipped, the same amount, so the
        pair nets to zero per asset. You ask with a reason and a case reference; nothing posts until a different founder approves exactly
        that request and you run it. A transaction is reversed once.
      </p>

      {list.kind === 'reading' && <p className="adm-subtle">Reading the reversal requests…</p>}
      {list.kind === 'refused' && (
        <p className="adm-alert" role="alert" data-testid="reversal-list-refused">
          {list.refusal ? `${list.refusal.title}. ${list.refusal.body}` : 'svc-ops did not answer the reversal requests.'}{' '}
          {list.refusal?.code && <code>{list.refusal.code}</code>}
        </p>
      )}
      {list.kind === 'ok' && list.reversals.length === 0 && (
        <p className="adm-subtle" data-testid="reversal-none">
          No reversal has been asked for on this transaction.
        </p>
      )}
      {list.kind === 'ok' &&
        list.reversals.map((r) => (
          <div key={r.requestNo} className="adm-stack" data-testid="reversal-request" data-request-no={r.requestNo} data-state={r.state}>
            <dl>
              <dt>Reversal request</dt>
              <dd>
                {r.requestNo} <span className="adm-subtle">(ledger key {r.ledgerKey})</span>
              </dd>
              <dt>State</dt>
              <dd>
                <code data-testid="reversal-state">{r.state}</code> <span className="adm-subtle">{reversalStateWords(r.state)}</span>
              </dd>
              <dt>Reason and case</dt>
              <dd>
                “{r.reason}”, case <code>{r.caseRef}</code>
              </dd>
              <dt>Asked by</dt>
              <dd>
                {r.requestedBy} at {formatWhen(r.requestedAt)}
              </dd>
              <dt>Approved by</dt>
              <dd>{r.approverId ?? 'Not approved yet'}</dd>
              {r.reversingTxId && (
                <>
                  <dt>Reversing transaction</dt>
                  <dd>
                    <TxLink id={r.reversingTxId} testId="reversal-reversing-tx" onFollow={onFollow} />
                  </dd>
                </>
              )}
              {r.code && (
                <>
                  <dt>Ledger answer</dt>
                  <dd>
                    <code data-testid="reversal-code">{r.code}</code>
                    {r.reversedBy && (
                      <>
                        {' '}
                        naming <TxLink id={r.reversedBy} testId="reversal-named-tx" onFollow={onFollow} />
                      </>
                    )}
                  </dd>
                </>
              )}
            </dl>
            {(r.state === 'intent' || r.state === 'pending_retry' || r.state === 'posting') && (
              <ControlDesk
                key={`reverse:${r.requestNo}`}
                endpoint="/api/ledger-reversals/approve"
                userId={userId}
                blockedReason={null}
                formHold={
                  r.state === 'intent'
                    ? writes
                      ? writes.title
                      : null
                    : 'This request is already approved; run it again from its packet below.'
                }
                action={{
                  heading: `Ask a different founder to approve reversal request ${r.requestNo}`,
                  submitLabel: 'Ask a second founder to approve the reversal',
                  needsReason: false,
                  reasonLabel: 'Reason',
                  build: () => ({
                    kind: 'ops.ledger.reverse',
                    requestNo: r.requestNo,
                    originalTxId: r.originalTxId,
                    reason: r.reason,
                    caseRef: r.caseRef,
                  }),
                  danger: true,
                }}
                consequence={`Two different founders must agree: you ask here, a different founder pastes the packet on their own console and approves it, then you run it. The ledger then books one compensating transaction for ${r.originalTxId} under ${r.ledgerKey}. If its answer is lost, running it again sends the same request under the same key.`}
                blockedButtonLabel="Reverse unavailable"
                onChanged={onRequestChanged}
              />
            )}
          </div>
        ))}

      <form onSubmit={onSubmit} className="adm-stack" data-testid="tx-reverse">
        <label className="adm-field">
          Reason (12 to 500 characters)
          <textarea value={reason} onChange={(event) => onReason(event.target.value)} maxLength={500} rows={2} />
        </label>
        <label className="adm-field">
          Case reference
          <input
            value={caseRef}
            onChange={(event) => onCaseRef(event.target.value)}
            maxLength={128}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        {writes && (
          <p className="adm-subtle" role="status" data-testid="reversal-writes-parked">
            {writes.title}. {writes.body}
          </p>
        )}
        {(reason !== '' || caseRef !== '') && !checked.ok && (
          <p className="adm-subtle" role="status">
            {checked.why}
          </p>
        )}
        <button
          type="submit"
          className="adm-btn"
          data-testid="tx-reverse-submit"
          disabled={!checked.ok || ask.kind === 'sending' || writes !== null}
        >
          Reverse
        </button>
      </form>

      {ask.kind === 'asked' && (
        <p role="status" data-testid="reversal-asked" data-request-no={ask.reversal.requestNo}>
          Reversal request {ask.reversal.requestNo} is stored at <code>{ask.reversal.state}</code>. Nothing has posted: ask a different
          founder to approve it above.
        </p>
      )}
      {ask.kind === 'refused' && (
        <div className="adm-alert" role="alert" data-testid="reversal-refused">
          <strong>{ask.refusal.title}</strong>
          <p>{ask.refusal.body}</p>
          <p>{ask.refusal.next}</p>
          {ask.refusal.code && (
            <p>
              Code <code data-testid="reversal-refused-code">{ask.refusal.code}</code>
            </p>
          )}
          {(ask.firstReversal ?? (ask.refusal.code === 'ops.reversal_already_reversed' ? first : null)) && (
            <p>
              First reversal: <TxLink id={(ask.firstReversal ?? first)!.reversingTxId} testId="reversal-first" onFollow={onFollow} />{' '}
              (reversal request {(ask.firstReversal ?? first)!.requestNo})
            </p>
          )}
        </div>
      )}
      {list.kind === 'ok' && <p className="adm-subtle">Requests read at {formatWhen(list.asOf)}.</p>}
    </section>
  );
}

function TxLink({ id, testId, onFollow }: { id: string; testId: string; onFollow: ((txId: string) => void) | undefined }) {
  return onFollow ? (
    <button type="button" className="adm-link" data-testid={testId} data-tx-id={id} onClick={() => onFollow(id)}>
      {id}
    </button>
  ) : (
    <code data-testid={testId} data-tx-id={id}>
      {id}
    </code>
  );
}
