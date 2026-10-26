import { useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ApiResult } from '../../shared/api';
import { Button, Dialog, Failure, Loading } from '../../shared/ui';
import { usePreferences } from '../../shared/preferences';
import { useSession } from '../session/session';
import { PresentedCopy, actionFailurePresentation, type useAction } from './common';
import { t as moreText, Text } from './copy';
import { createAcademyGrantApi, type AcademyKnown, type GrantOperation, type GrantRecord } from './academy-grant-api';
import { academyGrantCopy as copy } from './academy-grant-copy';

type Stage = Parameters<ReturnType<typeof useAction>['stage']>[0] & { grant?: GrantOperation };
type Review = Stage & { epoch: number; journalTitle: string };
const present = <T,>(value: T | (() => T)): T => (typeof value === 'function' ? (value as () => T)() : value);
/** One compatible action interface supplies every Academy writer. */
export function useAcademyAction() {
  const { userId, api } = useSession();
  const { language } = usePreferences();
  const owner = useRef({ userId, api, href: location.href, epoch: 0 });
  if (owner.current.userId !== userId || owner.current.api !== api || owner.current.href !== location.href)
    owner.current = { userId, api, href: location.href, epoch: owner.current.epoch + 1 };
  const context = owner.current;
  const lifetime = useRef({ context, mounted: true });
  lifetime.current.context = context;
  const model = useRef({ api, userId, value: createAcademyGrantApi(api, userId ?? 'anonymous') });
  if (model.current.api !== api || model.current.userId !== userId)
    model.current = { api, userId, value: createAcademyGrantApi(api, userId ?? 'anonymous') };
  const grantApi = model.current.value;
  const live = () =>
    Boolean(
      userId &&
      lifetime.current.mounted &&
      lifetime.current.context === context &&
      owner.current === context &&
      location.href === context.href &&
      api.canWrite(),
    );
  const interaction = useRef(0),
    admitted = useRef<Review | null>(null),
    operation = useRef<object | null>(null);
  const original = useRef<{ raw: string | null; context: typeof context; identity: object } | null>(null);
  const [revision, invalidate] = useState(0);
  const [missing, setMissing] = useState<{ context: typeof context; raw: string } | null>(null);
  const [state, setState] = useState<{
    context: typeof context;
    result: ApiResult<unknown> | null;
    success: Stage['success'];
    recorded: GrantRecord | null;
  }>({ context, result: null, success: '', recorded: null });
  const snapshot = grantApi.inspect(live);
  const raw = snapshot.status === 'grant' || snapshot.status === 'other' ? snapshot.raw : null;
  if (original.current?.raw !== raw || original.current.context !== context) original.current = { raw, context, identity: {} };
  const capturedOriginal = original.current;
  const shown = state.context === context && live() ? state : { context, result: null, success: '', recorded: null };
  const update = (change: Partial<typeof state>) => {
    if (live())
      setState((old) => ({ ...(old.context === context ? old : { context, result: null, success: '', recorded: null }), ...change }));
  };
  const redraw = () => invalidate((n) => n + 1);
  function retire() {
    interaction.current++;
    admitted.current = null;
    original.current = null;
    setMissing(null);
    redraw();
  }
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    const departed = () => {
      if (owner.current.href === location.href) return;
      owner.current = { ...owner.current, href: location.href, epoch: owner.current.epoch + 1 };
      lifetime.current.context = owner.current;
      flushSync(() => {
        retire();
        setState({ context: owner.current, result: null, success: '', recorded: null });
      });
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      lifetime.current.mounted = false;
      interaction.current++;
      admitted.current = null;
      original.current = null;
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
    };
  }, []);
  useLayoutEffect(() => {
    interaction.current++;
    admitted.current = null;
    original.current = null;
    operation.current = null;
    const changed = (event: StorageEvent) => {
      if (event.key === `intafaced:more:pending:${userId}:academy` || event.key === null) {
        retire();
        update({ result: null, success: '', recorded: null });
      }
    };
    window.addEventListener('storage', changed);
    redraw();
    return () => window.removeEventListener('storage', changed);
  }, [context]);
  const changed = () => ({ ok: false as const, reason: 'aborted' as const, code: 'academy.original_changed', message: copy.t('changed') });
  function stage(input: Stage) {
    const saved = grantApi.inspect(live);
    if (!live() || operation.current || saved.status !== 'empty' || saved.known) return;
    admitted.current = { ...input, epoch: interaction.current, journalTitle: present(input.title) };
    update({ result: null, success: '', recorded: null });
    redraw();
  }
  function dismiss(request: Review) {
    if (!live() || admitted.current !== request) return;
    retire();
  }
  async function send(request: Review) {
    if (!live() || admitted.current !== request || request.epoch !== interaction.current || operation.current) return;
    const action = {};
    operation.current = action;
    redraw();
    const reviewCurrent = () =>
      live() && admitted.current === request && interaction.current === request.epoch && operation.current === action;
    const marker = {
      id: crypto.randomUUID(),
      title: request.journalTitle,
      ...(request.reference ? { reference: request.reference } : {}),
      ...(request.grant ? { kind: 'grant' } : {}),
    };
    const result = await grantApi.execute(marker, request.run, reviewCurrent, live, request.grant);
    if (!live() || operation.current !== action) return;
    const stillReviewed = reviewCurrent();
    operation.current = null;
    if (admitted.current === request) admitted.current = null;
    const published = stillReviewed ? result : result.ok ? changed() : result;
    update({ result: published, success: published.ok ? request.success : '', recorded: null });
    redraw();
    if (stillReviewed && result.ok) request.done?.();
  }
  async function check() {
    const originalCurrent = () =>
      live() &&
      original.current === capturedOriginal &&
      grantApi.inspect(live).status === 'grant' &&
      (grantApi.inspect(live) as { raw?: string }).raw === raw;
    if (!raw || snapshot.status !== 'grant' || snapshot.known || operation.current || !originalCurrent()) return;
    const action = {};
    operation.current = action;
    setMissing(null);
    update({ result: null, success: '', recorded: null });
    redraw();
    const result = await grantApi.checkOriginal(raw, () => originalCurrent() && operation.current === action, live);
    if (!live() || operation.current !== action) return;
    const saved = grantApi.inspect(live);
    const ownCleanup = result.ok && result.data?.idempotencyKey === snapshot.marker.reference && saved.status === 'empty';
    operation.current = null;
    if (!originalCurrent() && !ownCleanup) {
      redraw();
      return;
    }
    if (result.ok && !result.data) setMissing({ context, raw });
    update({ result: result.ok ? null : result, success: '', recorded: result.ok ? result.data : null });
    redraw();
  }
  async function cleanup(proof: AcademyKnown) {
    if (!live() || grantApi.inspect(live).known !== proof || operation.current) return;
    const action = {};
    operation.current = action;
    redraw();
    await grantApi.cleanupKnown(proof, () => live() && operation.current === action);
    if (!live() || operation.current !== action) return;
    operation.current = null;
    redraw();
  }
  const failure = shown.result && !shown.result.ok ? shown.result : null;
  const presentation = failure ? actionFailurePresentation(failure, language) : null;
  const ownedFailure = failure?.code?.startsWith('academy.original_');
  const feedback = (
    <>
      {operation.current && <Loading label={moreText('common.waiting.for.the.service')} />}
      {failure && (
        <div
          lang={
            presentation?.language ??
            (ownedFailure
              ? copy.forLocale(language).languageFor(failure.code === 'academy.original_changed' ? 'changed' : 'unavailable')
              : 'und')
          }
          style={{ display: 'contents' }}
        >
          <Failure
            result={
              presentation
                ? { ...failure, message: presentation.message, messageCopy: undefined }
                : ownedFailure
                  ? { ...failure, message: copy.t(failure.code === 'academy.original_changed' ? 'changed' : 'unavailable') }
                  : failure
            }
          />
        </div>
      )}
      {!operation.current && shown.result?.ok && shown.success && (
        <p role="status" className="more-success">
          <PresentedCopy value={shown.success} />
        </p>
      )}
      {snapshot.status === 'other' && !operation.current && (
        <div data-testid="failure" className="failure" role="alert">
          <h3>
            <Text k="common.outcome.not.confirmed" />
          </h3>
          <p>
            <Text k="common.earlier.request" />
            <span lang="und">{snapshot.marker.title}</span>{' '}
            {snapshot.marker.reference && <code lang="zxx">{snapshot.marker.reference}</code>}
            <Text k="common.read.its.original.records.before.continuing" />
          </p>
          <p>
            <Text k="common.this.action.has.no.universal.recovery.lookup" />
          </p>
        </div>
      )}
      {snapshot.known && !snapshot.known.grant && (
        <div data-testid="failure" className="failure">
          <p lang={copy.forLocale(language).languageFor('actionCleanup')}>{copy.t('actionCleanup')}</p>
          <Button lang={copy.forLocale(language).languageFor('cleanupAction')} onClick={() => void cleanup(snapshot.known!)}>
            {copy.t('cleanupAction')}
          </Button>
        </div>
      )}
      {snapshot.status === 'unreadable' && !snapshot.known && (
        <div data-testid="failure" className="failure" role="alert">
          <h3 lang={copy.forLocale(language).languageFor('storageTitle')}>{copy.t('storageTitle')}</h3>
          <p lang={copy.forLocale(language).languageFor('storageBody')}>{copy.t('storageBody')}</p>
          <Button variant="secondary" lang={copy.forLocale(language).languageFor('retryStorage')} onClick={redraw}>
            {copy.t('retryStorage')}
          </Button>
        </div>
      )}
    </>
  );
  const request = admitted.current;
  const dialog =
    live() && request && request.epoch === interaction.current && !operation.current ? (
      <Dialog title={<PresentedCopy value={request.title} />} onClose={() => dismiss(request)}>
        <PresentedCopy value={request.content} />
        <p className="muted">
          <Text k="common.acting.as.account" />
          <code lang="zxx">{userId}</code>
          <Text k="common.the.service.enforces.your.scope.and.jurisdiction" />
        </p>
        <div className="actions">
          <Button variant="secondary" onClick={() => dismiss(request)}>
            <Text k="common.back" />
          </Button>
          <Button onClick={() => void send(request)}>
            <PresentedCopy value={request.confirm} />
          </Button>
        </div>
      </Dialog>
    ) : null;
  void revision;
  return {
    stage,
    feedback,
    dialog,
    isCurrent: live,
    result: shown.result,
    disabled: Boolean(operation.current || snapshot.status !== 'empty' || snapshot.known || !live()),
    retire,
    grantApi,
    snapshot,
    check,
    cleanup,
    recorded: shown.recorded,
    busy: Boolean(operation.current),
    readContext: context,
    noMatch: missing?.context === context && missing.raw === raw,
  };
}
export type AcademyAction = ReturnType<typeof useAcademyAction>;
