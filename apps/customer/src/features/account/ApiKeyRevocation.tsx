import { useLayoutEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../shared/api';
import type { JournalRead } from '../../shared/minimal-original-journal';
import { Button, Dialog, Loading } from '../../shared/ui';
import { currentSharedCardRoute, subscribeSharedCardRoute } from '../more/blueprint-shared-card-contract';
import { readApiKeyRecords, type ApiKeyRecord, type ApiKeyReadWindow } from './api-key-records-api';
import {
  apiKeyRevokeStorageKey,
  canReviewApiKeyRevoke,
  createApiKeyRevokeJournal,
  directApiKeyRevokeProof,
  revokeApiKey,
  type ApiKeyRevokeOriginal,
  type DirectApiKeyRevokeProof,
} from './api-key-revoke-contract';
import { copy } from './copy';

export type ApiKeyInventoryReceipt = Readonly<{ rows: readonly ApiKeyRecord[] }>;
type Options = {
  api: ApiClient;
  owner: string | null;
  session: object | null;
  context: object;
  limit: ApiKeyReadWindow;
  inventory: ApiKeyInventoryReceipt | null;
  current(): boolean;
  actionCurrent(): boolean;
  inventoryCurrent(receipt: ApiKeyInventoryReceipt): boolean;
};
type Context = Readonly<{
  api: ApiClient;
  owner: string;
  session: object;
  parent: object;
  route: ReturnType<typeof currentSharedCardRoute>;
  limit: ApiKeyReadWindow;
  journal: ReturnType<typeof createApiKeyRevokeJournal>;
}>;
type Saved = Readonly<{ context: Context; read: JournalRead<ApiKeyRevokeOriginal> }>;
type Review = Readonly<{
  context: Context;
  inventory: ApiKeyInventoryReceipt;
  target: Readonly<ApiKeyRecord>;
  source: HTMLButtonElement | null;
}>;
type Operation = Readonly<{ review: Review; original: ApiKeyRevokeOriginal; raw: string; controller: AbortController }>;
type Known = Readonly<{ context: Context; original: ApiKeyRevokeOriginal; raw: string; proof: DirectApiKeyRevokeProof; retained: boolean }>;
type DialogState = Readonly<{ review: Review; phase: 'review' | 'sending' | 'done' }>;
type Arrival =
  | Readonly<{ kind: 'outcome'; context: Context; saved: Saved | null; known: Known | null }>
  | Readonly<{ kind: 'source'; context: Context; review: Review }>;
type CurrentState = Readonly<{
  saved: Saved;
  controller: AbortController;
  status: 'loading' | 'failed' | 'revoked' | 'not-revoked' | 'missing';
}>;

/** Inventory admission and direct-response proof have separate lifetimes.
 * Closing private Review retires its transport, while a verified result can
 * still authorize exact local cleanup. A later owner list never supplies proof.
 */
export function useApiKeyRevocation(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(false);
  const contextRef = useRef<Context | null>(null);
  const savedRef = useRef<Saved | null>(null);
  const reviewRef = useRef<Review | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const knownRef = useRef<Known | null>(null);
  const dialogRef = useRef<DialogState | null>(null);
  const currentStateRef = useRef<CurrentState | null>(null);
  const spentInventory = useRef<ApiKeyInventoryReceipt | null>(null);
  const arrivalRef = useRef<Arrival | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState(false);
  function repaint() {
    setRevision((value) => value + 1);
  }
  function retireReview() {
    operationRef.current?.controller.abort();
    operationRef.current = null;
    reviewRef.current = null;
    dialogRef.current = null;
  }
  function retireCurrentRead() {
    currentStateRef.current?.controller.abort();
    currentStateRef.current = null;
  }
  function retireContext() {
    retireReview();
    retireCurrentRead();
    knownRef.current = null;
    savedRef.current = null;
    spentInventory.current = null;
    arrivalRef.current = null;
  }
  const route = currentSharedCardRoute();
  const previous = contextRef.current;
  if (!options.owner || !options.session) {
    if (previous) retireContext();
    contextRef.current = null;
  } else if (
    !previous ||
    previous.api !== options.api ||
    previous.owner !== options.owner ||
    previous.session !== options.session ||
    previous.parent !== options.context ||
    previous.route !== route ||
    previous.limit !== options.limit
  ) {
    retireContext();
    contextRef.current = Object.freeze({
      api: options.api,
      owner: options.owner,
      session: options.session,
      parent: options.context,
      route,
      limit: options.limit,
      journal: createApiKeyRevokeJournal(options.owner, {
        durable: () => window.localStorage,
        locks: () => navigator.locks,
      }),
    });
  }
  const context = contextRef.current;
  const contextCurrent = (captured: Context | null) =>
    !!captured &&
    mounted.current &&
    contextRef.current === captured &&
    latest.current.context === captured.parent &&
    latest.current.owner === captured.owner &&
    latest.current.session === captured.session &&
    latest.current.api === captured.api &&
    latest.current.limit === captured.limit &&
    captured.api.canWrite() &&
    currentSharedCardRoute() === captured.route &&
    latest.current.current();
  const actionCurrent = () => contextCurrent(context) && options.actionCurrent();
  function showSaved(captured: Context, read: JournalRead<ApiKeyRevokeOriginal>): Saved {
    const previousSaved = savedRef.current;
    const same =
      previousSaved?.context === captured &&
      previousSaved.read.status === read.status &&
      (read.status !== 'present' || (previousSaved.read.status === 'present' && previousSaved.read.raw === read.raw));
    if (same) return previousSaved;
    retireCurrentRead();
    const known = knownRef.current;
    if (known?.context === captured && read.status === 'present' && read.raw !== known.raw) knownRef.current = null;
    const next = Object.freeze({ context: captured, read });
    savedRef.current = next;
    return next;
  }
  function refreshSaved(captured: Context) {
    if (!contextCurrent(captured)) return;
    showSaved(captured, captured.journal.read());
    repaint();
  }
  useLayoutEffect(() => {
    mounted.current = true;
    const release = subscribeSharedCardRoute(() => {
      retireContext();
      contextRef.current = null;
      repaint();
    });
    function storage(event: StorageEvent) {
      const captured = contextRef.current;
      if (!captured || (event.key !== null && event.key !== apiKeyRevokeStorageKey(captured.owner))) return;
      // Observe replacement even if a batched A→B→A ends with identical bytes.
      retireReview();
      retireCurrentRead();
      knownRef.current = null;
      savedRef.current = null;
      refreshSaved(captured);
    }
    window.addEventListener('storage', storage);
    return () => {
      mounted.current = false;
      contextRef.current = null;
      retireContext();
      window.removeEventListener('storage', storage);
      release();
    };
  }, []);
  useLayoutEffect(() => {
    if (context) refreshSaved(context);
  }, [context]);
  useLayoutEffect(() => {
    const review = reviewRef.current;
    if (review && !latest.current.inventoryCurrent(review.inventory)) retireReview();
    retireCurrentRead();
    repaint();
  }, [options.inventory]);

  function reviewCurrent(review: Review) {
    return contextCurrent(review.context) && reviewRef.current === review && latest.current.inventoryCurrent(review.inventory);
  }
  function operationCurrent(operation: Operation) {
    if (operationRef.current !== operation || operation.controller.signal.aborted || !reviewCurrent(operation.review)) return false;
    const read = operation.review.context.journal.read();
    return read.status === 'present' && read.raw === operation.raw;
  }
  function review(record: ApiKeyRecord, source?: HTMLButtonElement) {
    const inventory = options.inventory;
    if (
      !context ||
      !actionCurrent() ||
      !inventory ||
      !options.inventoryCurrent(inventory) ||
      !inventory.rows.includes(record) ||
      !canReviewApiKeyRevoke(record) ||
      spentInventory.current === inventory ||
      dialogRef.current
    )
      return;
    const read = context.journal.read();
    showSaved(context, read);
    if (read.status !== 'empty' || knownRef.current?.retained) {
      repaint();
      return;
    }
    const target = Object.freeze({ ...record, scopes: Object.freeze([...record.scopes]) }) as Readonly<ApiKeyRecord>;
    arrivalRef.current = null;
    const next: Review = Object.freeze({ context, inventory, target, source: source ?? null });
    reviewRef.current = next;
    dialogRef.current = Object.freeze({ review: next, phase: 'review' });
    setNotice(false);
    repaint();
  }
  const dialog = dialogRef.current;
  function close() {
    if (!dialog || !contextCurrent(dialog.review.context) || dialogRef.current !== dialog) return;
    retireReview();
    refreshSaved(dialog.review.context);
    // Capture the source at admission: the row is disabled before Dialog's
    // passive effect can remember it. Return only to this still-current row.
    arrivalRef.current =
      dialog.phase === 'review'
        ? Object.freeze({ kind: 'source', context: dialog.review.context, review: dialog.review })
        : Object.freeze({ kind: 'outcome', context: dialog.review.context, saved: savedRef.current, known: knownRef.current });
    repaint();
  }
  async function confirm() {
    const review = dialog?.review;
    if (!review || !reviewCurrent(review) || dialogRef.current !== dialog || dialog.phase !== 'review' || operationRef.current) return;
    const original: ApiKeyRevokeOriginal = Object.freeze({
      kind: 'api-key-revoke',
      owner: review.context.owner,
      keyId: review.target.id,
      originalId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const operation: Operation = Object.freeze({ review, original, raw: JSON.stringify(original), controller: new AbortController() });
    operationRef.current = operation;
    dialogRef.current = Object.freeze({ review, phase: 'sending' });
    repaint();
    const coordinated = await review.context.journal.coordinate(async (lease) => {
      if (!reviewCurrent(review) || operationRef.current !== operation || operation.controller.signal.aborted) return;
      const before = lease.read();
      showSaved(review.context, before);
      if (before.status !== 'empty') {
        setNotice(true);
        return;
      }
      const saved = lease.writeExact(null, operation.raw);
      showSaved(review.context, lease.read());
      if (!saved.ok || !operationCurrent(operation)) {
        setNotice(true);
        return;
      }
      // This receipt cannot supply a second write after its one captured request.
      spentInventory.current = review.inventory;
      let proof: DirectApiKeyRevokeProof | null = null;
      try {
        const result = await revokeApiKey(review.context.api, original.keyId, operation.controller.signal);
        if (!operationCurrent(operation)) return;
        proof = directApiKeyRevokeProof(result);
      } catch {
        /* Invocation may have reached the service; retain the original. */
      }
      if (!operationCurrent(operation)) return;
      if (proof) {
        const known: Known = Object.freeze({ context: review.context, original, raw: operation.raw, proof, retained: true });
        knownRef.current = known;
        const finished = lease.finishExact(operation.raw);
        if (!contextCurrent(review.context) || operationRef.current !== operation || reviewRef.current !== review) return;
        knownRef.current = Object.freeze({ ...known, retained: !finished.ok });
      }
      showSaved(review.context, lease.read());
    });
    if (!contextCurrent(review.context) || operationRef.current !== operation || reviewRef.current !== review) return;
    const finalRead = review.context.journal.read();
    if (finalRead.status === 'present' && finalRead.raw !== operation.raw) {
      retireReview();
      refreshSaved(review.context);
      return;
    }
    operationRef.current = null;
    if (!coordinated.ok) setNotice(true);
    dialogRef.current = Object.freeze({ review, phase: 'done' });
    refreshSaved(review.context);
  }
  const saved = savedRef.current?.context === context ? savedRef.current : null;
  const known = knownRef.current?.context === context ? knownRef.current : null;
  const currentState = currentStateRef.current?.saved === saved ? currentStateRef.current : null;
  function retryRead() {
    if (!context || !actionCurrent() || savedRef.current !== saved) return;
    retireReview();
    refreshSaved(context);
  }
  async function cleanup() {
    if (!known || !known.retained || !actionCurrent() || knownRef.current !== known) return;
    const coordinated = await known.context.journal.coordinate(async (lease) => {
      if (!contextCurrent(known.context) || knownRef.current !== known || !options.actionCurrent()) return;
      const read = lease.read();
      // If removal succeeded but verification failed, observing empty now is a
      // local confirmation. Never delete a replacement or infer service proof.
      const finished =
        read.status === 'empty'
          ? { ok: true }
          : read.status === 'present' && read.raw === known.raw
            ? lease.finishExact(known.raw)
            : { ok: false };
      if (!contextCurrent(known.context) || knownRef.current !== known) return;
      if (finished.ok) knownRef.current = Object.freeze({ ...known, retained: false });
      showSaved(known.context, lease.read());
    });
    if (!contextCurrent(known.context) || (knownRef.current !== known && knownRef.current?.raw !== known.raw)) return;
    if (!coordinated.ok) setNotice(true);
    repaint();
  }
  async function readCurrent() {
    if (
      !context ||
      !saved ||
      saved.read.status !== 'present' ||
      !actionCurrent() ||
      savedRef.current !== saved ||
      currentStateRef.current !== currentState ||
      currentState?.status === 'loading'
    )
      return;
    const before = context.journal.read();
    if (before.status !== 'present' || before.raw !== saved.read.raw) {
      refreshSaved(context);
      return;
    }
    retireCurrentRead();
    const request: CurrentState = Object.freeze({ saved, controller: new AbortController(), status: 'loading' });
    currentStateRef.current = request;
    repaint();
    const isCurrent = () =>
      contextCurrent(context) &&
      options.actionCurrent() &&
      savedRef.current === saved &&
      currentStateRef.current === request &&
      !request.controller.signal.aborted &&
      (() => {
        const read = context.journal.read();
        return read.status === 'present' && read.raw === (saved.read.status === 'present' ? saved.read.raw : null);
      })();
    let status: CurrentState['status'] = 'failed';
    try {
      const result = await readApiKeyRecords(context.api, context.limit, request.controller.signal);
      if (!isCurrent()) return;
      if (result.ok) {
        const target = result.data.find((row) => row.id === (saved.read.status === 'present' ? saved.read.value.keyId : null));
        status = target ? (target.revoked ? 'revoked' : 'not-revoked') : 'missing';
      }
    } catch {
      /* Failed reads publish no stale private rows. */
    }
    if (!isCurrent()) return;
    currentStateRef.current = Object.freeze({ ...request, status });
    repaint();
  }
  const arrival = arrivalRef.current;
  function arrivalCurrent(captured: Arrival) {
    if (arrivalRef.current !== captured || !contextCurrent(captured.context) || dialogRef.current || !latest.current.actionCurrent())
      return false;
    const read = captured.context.journal.read();
    if (captured.kind === 'source')
      return (
        latest.current.inventoryCurrent(captured.review.inventory) &&
        !!captured.review.source?.isConnected &&
        !captured.review.source.disabled &&
        read.status === 'empty'
      );
    if (savedRef.current !== captured.saved || knownRef.current !== captured.known) return false;
    if (captured.known) return read.status !== 'present' || read.raw === captured.known.raw;
    return captured.saved?.read.status === 'present'
      ? read.status === 'present' && read.raw === captured.saved.read.raw
      : captured.saved?.read.status === 'unreadable' && read.status === 'unreadable';
  }
  return {
    revision,
    arrival,
    arrivalCurrent,
    refreshRequired: !!known && !known.retained && spentInventory.current === options.inventory,
    review,
    dialog: dialog && contextCurrent(dialog.review.context) ? dialog : null,
    close,
    confirm,
    saved,
    known,
    currentState,
    cleanup,
    retryRead,
    readCurrent,
    notice,
    blocked:
      !context ||
      !actionCurrent() ||
      !saved ||
      saved.read.status !== 'empty' ||
      !!known?.retained ||
      !!dialog ||
      spentInventory.current === options.inventory,
  };
}

export function ApiKeyRevocation({ action }: { action: ReturnType<typeof useApiKeyRevocation> }) {
  const { Copy } = copy.useCopy();
  const { saved, known, dialog, currentState } = action;
  const outcome = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const arrival = action.arrival;
    if (!arrival || dialog) return;
    // Run after the Dialog primitive has restored its prior focus. Recheck the
    // exact current result before this queued visual action; stale context,
    // original or Review callbacks must not steal the new view's focus.
    const timer = window.setTimeout(() => {
      const target = arrival.kind === 'source' ? arrival.review.source : outcome.current;
      if (!action.arrivalCurrent(arrival) || !target?.isConnected) return;
      target.focus({ preventScroll: true });
      if (arrival.kind === 'outcome') target.scrollIntoView({ block: 'center' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [action.arrival, dialog]);

  const proofTitle =
    known?.proof === 'marked-revoked'
      ? 'api.revoke.marked'
      : known?.proof === 'no-matching-change'
        ? 'api.revoke.no.change'
        : 'api.revoke.denied';
  const refs = (original: ApiKeyRevokeOriginal) => (
    <dl className="api-key-revoke__refs">
      <div>
        <dt>
          <Copy k="api.revoke.key.id" />
        </dt>
        <dd>
          <bdi lang="und">{original.keyId}</bdi>
        </dd>
      </div>
      <div>
        <dt>
          <Copy k="api.revoke.saved.reference" />
        </dt>
        <dd>
          <bdi lang="und">{original.originalId}</bdi>
        </dd>
      </div>
    </dl>
  );
  return (
    <>
      {known && (
        <div data-testid="api-key-revoke--known" className="api-key-revoke api-key-revoke--known" role="status">
          <h3 ref={outcome} data-testid="api-key-revoke__outcome-heading" className="api-key-revoke__outcome-heading" tabIndex={-1}>
            <Copy k={proofTitle} />
          </h3>
          <p>
            <Copy
              k={
                known.proof === 'marked-revoked'
                  ? 'api.revoke.marked.body'
                  : known.proof === 'no-matching-change'
                    ? 'api.revoke.no.change.body'
                    : 'api.revoke.denied.body'
              }
            />
          </p>
          {known.proof === 'marked-revoked' && (
            <p className="muted">
              <Copy k="api.revoke.token.limit" />
            </p>
          )}
          {known.proof === 'no-matching-change' && (
            <p className="muted">
              <Copy k="api.revoke.no.change.limit" />
            </p>
          )}
          {refs(known.original)}
          {action.refreshRequired && (
            <p className="muted">
              <Copy k="api.revoke.refresh.next" />
            </p>
          )}
          {known.retained && (
            <>
              <h4>
                <Copy k="api.revoke.cleanup.title" />
              </h4>
              <p className="muted">
                <Copy k="api.revoke.cleanup.body" />
              </p>
              <Button variant="secondary" onClick={() => void action.cleanup()}>
                <Copy k="api.revoke.cleanup.retry" />
              </Button>
            </>
          )}
        </div>
      )}
      {!known && saved?.read.status === 'present' && (
        <div data-testid="api-key-revoke--unknown" className="api-key-revoke api-key-revoke--unknown" role="status">
          <h3 ref={outcome} data-testid="api-key-revoke__outcome-heading" className="api-key-revoke__outcome-heading" tabIndex={-1}>
            <Copy k="api.revoke.unknown" />
          </h3>
          <p>
            <Copy k="api.revoke.unknown.body" />
          </p>
          {refs(saved.read.value)}
          <p className="muted">
            <Copy k="api.revoke.blocked.body" />
          </p>
          <div data-testid="api-key-revoke__current" className="api-key-revoke__current">
            <h4>
              <Copy k="api.revoke.current.title" />
            </h4>
            <Button variant="secondary" disabled={currentState?.status === 'loading'} onClick={() => void action.readCurrent()}>
              <Copy k="api.revoke.current.read" />
            </Button>
            {currentState?.status === 'loading' && <Loading label={<Copy k="api.records.loading" />} />}
            {currentState && currentState.status !== 'loading' && (
              <p>
                <Copy
                  k={
                    currentState.status === 'revoked'
                      ? 'api.revoke.current.revoked'
                      : currentState.status === 'not-revoked'
                        ? 'api.revoke.current.not.revoked'
                        : currentState.status === 'missing'
                          ? 'api.revoke.current.missing'
                          : 'api.records.failed'
                  }
                />
              </p>
            )}
            <p className="muted">
              <Copy k="api.revoke.current.limit" />
            </p>
          </div>
        </div>
      )}
      {saved?.read.status === 'unreadable' && (
        <div data-testid="api-key-revoke--unavailable" className="api-key-revoke api-key-revoke--unavailable" role="status">
          <h3
            ref={known ? undefined : outcome}
            data-testid="api-key-revoke__outcome-heading"
            className="api-key-revoke__outcome-heading"
            tabIndex={-1}
          >
            <Copy k="api.revoke.unavailable" />
          </h3>
          <p className="muted">
            <Copy k="api.revoke.unavailable.body" />
          </p>
          <Button variant="secondary" onClick={action.retryRead}>
            <Copy k="api.revoke.retry.local" />
          </Button>
        </div>
      )}
      {action.notice && (
        <p role="status">
          <Copy k="api.revoke.admission.refused" />
        </p>
      )}
      {dialog && (
        <Dialog title={<Copy k="api.revoke.review.title" />} onClose={action.close}>
          <div data-testid="api-key-revoke__review" className="api-key-revoke__review">
            <p className="muted">
              <Copy k="api.revoke.review.source" />
            </p>
            <h3>{dialog.review.target.name ? <bdi lang="und">{dialog.review.target.name}</bdi> : <Copy k="api.records.unnamed" />}</h3>
            <dl className="api-key-revoke__refs">
              <div>
                <dt>
                  <Copy k="api.revoke.key.id" />
                </dt>
                <dd>
                  <bdi lang="und">{dialog.review.target.id}</bdi>
                </dd>
              </div>
              <div>
                <dt>
                  <Copy k="api.records.prefix" />
                </dt>
                <dd>
                  <bdi lang="und">{dialog.review.target.prefix}</bdi>
                </dd>
              </div>
              <div>
                <dt>
                  <Copy k="api.records.mode" />
                </dt>
                <dd>
                  <bdi lang="und">{dialog.review.target.mode}</bdi>
                </dd>
              </div>
              <div>
                <dt>
                  <Copy k="api.records.scopes" />
                </dt>
                <dd>
                  {dialog.review.target.scopes.map((scope, index) => (
                    <bdi key={index} lang="und">
                      {index ? ' · ' : ''}
                      {scope}
                    </bdi>
                  ))}
                </dd>
              </div>
            </dl>
            <p>
              <Copy k="api.revoke.consequence" />
            </p>
            <p className="muted">
              <Copy k="api.revoke.token.limit" />
            </p>
            {dialog.phase === 'sending' && <Loading label={<Copy k="api.revoke.sending" />} />}
            {dialog.phase === 'done' && (
              <p role="status">
                <Copy k={known ? proofTitle : saved?.read.status === 'present' ? 'api.revoke.unknown' : 'api.revoke.admission.refused'} />
              </p>
            )}
            <div data-testid="api-key-revoke__actions" className="api-key-revoke__actions">
              {dialog.phase === 'review' && (
                <Button onClick={() => void action.confirm()}>
                  <Copy k="api.revoke.confirm" />
                </Button>
              )}
              <Button variant="secondary" onClick={action.close}>
                <Copy k={dialog.phase === 'review' ? 'api.revoke.cancel' : 'api.revoke.close'} />
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
