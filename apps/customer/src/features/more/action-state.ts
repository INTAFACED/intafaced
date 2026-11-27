/**
 * The More rooms' staged action, without its drawing: the review it admits, the one send under its journal, the original
 * outcome read back, and what the room shows. `useAction` (common.tsx) draws it with the old parts; `useKitAction`
 * (volt-action.tsx) draws the same states with the kit's. The logic is one.
 */
import { t as copyText } from './copy';
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createMoreActionJournal, morePendingKey, type MoreKnown } from './more-action-journal';
import { moreActionCopy } from './more-action-copy';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
import { usePaperMode } from './paper-context';
import type { ApiResult } from '../../shared/api';
import { useSession } from '../session';
import { usePreferences } from '../../shared/preferences';
import type { UiLocale } from '../../shared/i18n';

// Presentation may follow View while the staged operation and journal stay fixed.
export type Presented<T> = T | (() => T);
export function present<T>(value: Presented<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}
type FailurePresentation = (locale: UiLocale) => { message: string; language: UiLocale };
const failurePresentations = new WeakMap<object, FailurePresentation>();
/** Academy's compatible action hook shares authored failure presentation only. */
export function actionFailurePresentation(result: ApiResult<unknown>, locale: UiLocale) {
  return failurePresentations.get(result)?.(locale);
}
/** Register explicit authored copy at its origin. Opaque service prose stays outside this seam. */
export function presentActionFailure<T extends Extract<ApiResult<unknown>, { ok: false }>>(
  result: T,
  presentation: FailurePresentation,
): T {
  failurePresentations.set(result, presentation);
  return result;
}

/** The refusal every write in a More room's simulated view answers with, before any request. */
export function paperRefusal() {
  return presentActionFailure(
    { ok: false as const, reason: 'forbidden' as const, code: 'more.paper_view', message: moreRoomRoutesCopy.t('paperRefused') },
    (locale) => {
      const current = moreRoomRoutesCopy.forLocale(locale);
      return { message: current.t('paperRefused'), language: current.languageFor('paperRefused') };
    },
  );
}
type Stage = {
  title: Presented<string>;
  content: Presented<ReactNode>;
  confirm: Presented<string>;
  reference?: string;
  run: (canDispatch: () => boolean) => Promise<ApiResult<unknown>>;
  done?: () => void;
  success: Presented<string>;
};
type Review = Stage & { journalTitle: string; epoch: number };
export function useActionState(
  room: string,
  recovery?: { recover: (reference: string) => Promise<ApiResult<unknown>>; done?: () => void },
) {
  const { userId, api, session } = useSession();
  const { language } = usePreferences();
  const paper = usePaperMode();
  const key = morePendingKey(userId ?? 'anonymous', room);
  const owner = useRef({ userId, api, session, key, href: location.href, epoch: 0 });
  if (
    owner.current.userId !== userId ||
    owner.current.api !== api ||
    owner.current.session !== session ||
    owner.current.key !== key ||
    owner.current.href !== location.href
  )
    owner.current = { userId, api, session, key, href: location.href, epoch: owner.current.epoch + 1 };
  const context = owner.current;
  // Opaque RAM identity for private projections. Consumers never receive the
  // owner/session context or use this identity as original settlement proof.
  const viewIdentity = useMemo(() => ({}), [context]);
  const lifetime = useRef({ context, mounted: true });
  lifetime.current.context = context;
  const model = useRef<{ key: string; api: typeof api; value: ReturnType<typeof createMoreActionJournal> } | null>(null);
  if (!model.current || model.current.key !== key || model.current.api !== api)
    model.current = { key, api, value: createMoreActionJournal(key) };
  const journal = model.current.value;
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
  const [state, setState] = useState<{ context: typeof context; result: ApiResult<unknown> | null; success: Presented<string> }>({
    context,
    result: null,
    success: '',
  });
  const snapshot = journal.inspect(live),
    saved = snapshot.saved;
  const raw = saved.status === 'present' ? saved.raw : null;
  if (original.current?.raw !== raw || original.current.context !== context) original.current = { raw, context, identity: {} };
  const capturedOriginal = original.current;
  const shown = state.context === context && live() ? state : { context, result: null, success: '' };
  const redraw = () => invalidate((n) => n + 1);
  const update = (result: ApiResult<unknown> | null, success: Presented<string> = '') => {
    if (live()) setState({ context, result, success });
  };
  function retire() {
    interaction.current++;
    admitted.current = null;
    original.current = null;
  }
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    const departed = () => {
      if (owner.current.href === location.href) return;
      owner.current = { ...owner.current, href: location.href, epoch: owner.current.epoch + 1 };
      lifetime.current.context = owner.current;
      retire();
      flushSync(redraw);
    };
    window.addEventListener('popstate', departed);
    window.addEventListener('hashchange', departed);
    return () => {
      lifetime.current.mounted = false;
      retire();
      window.removeEventListener('popstate', departed);
      window.removeEventListener('hashchange', departed);
    };
  }, []);
  useLayoutEffect(() => {
    retire();
    operation.current = null;
    const changed = (event: StorageEvent) => {
      if (event.key === key || event.key === null) {
        retire();
        journal.invalidateKnown();
        update(null);
        redraw();
      }
    };
    window.addEventListener('storage', changed);
    redraw();
    return () => window.removeEventListener('storage', changed);
  }, [context]);
  function stage(input: Stage) {
    // A simulated view (MC-order-01) never sends: the control answers with the refusal instead of the review dialog.
    if (paper) {
      update(paperRefusal());
      return;
    }
    const current = journal.inspect(live);
    if (!live() || operation.current || current.saved.status !== 'empty' || current.known) return;
    admitted.current = { ...input, epoch: ++interaction.current, journalTitle: present(input.title) };
    update(null);
    redraw();
  }
  function dismiss(request: Review) {
    if (!live() || admitted.current !== request || operation.current) return;
    retire();
    redraw();
  }
  async function send(request: Review) {
    if (paper || !live() || admitted.current !== request || request.epoch !== interaction.current || operation.current) return;
    const action = {};
    operation.current = action;
    redraw();
    const current = () => live() && admitted.current === request && request.epoch === interaction.current && operation.current === action;
    const result = await journal.execute(
      { id: crypto.randomUUID(), title: request.journalTitle, ...(request.reference ? { reference: request.reference } : {}) },
      request.run,
      current,
      live,
    );
    if (!live() || operation.current !== action) return;
    const stillReviewed = current();
    operation.current = null;
    if (admitted.current === request) admitted.current = null;
    update(result, stillReviewed && result.ok ? request.success : '');
    redraw();
    if (stillReviewed && result.ok) request.done?.();
  }
  async function recoverOriginal() {
    const current = () => {
      const now = journal.inspect(live).saved;
      return live() && original.current === capturedOriginal && now.status === 'present' && now.raw === raw;
    };
    if (
      paper ||
      !raw ||
      !recovery ||
      saved.status !== 'present' ||
      !saved.value.reference ||
      snapshot.known ||
      operation.current ||
      !current()
    )
      return;
    const action = {};
    operation.current = action;
    update(null);
    redraw();
    const result = await journal.recover(raw, recovery.recover, () => current() && operation.current === action, live);
    if (!live() || operation.current !== action) return;
    const after = journal.inspect(live).saved;
    const ownCleanup = result.ok && after.status === 'empty' && original.current === capturedOriginal;
    operation.current = null;
    if (!current() && !ownCleanup) {
      redraw();
      return;
    }
    update(result, result.ok ? () => copyText('common.original.outcome.verified') : '');
    redraw();
    if (result.ok) recovery.done?.();
  }
  async function cleanup(proof: MoreKnown) {
    if (!live() || journal.inspect(live).known !== proof || operation.current) return;
    const action = {};
    operation.current = action;
    redraw();
    await journal.cleanup(proof, () => live() && operation.current === action);
    if (!live() || operation.current !== action) return;
    operation.current = null;
    redraw();
  }
  const failure = shown.result && !shown.result.ok ? shown.result : null;
  const presentation = failure ? failurePresentations.get(failure)?.(language) : undefined;
  const copy = moreActionCopy.forLocale(language);
  const problem = failure?.code?.startsWith('more.original_') ? failure.code.slice('more.original_'.length) : null;
  const problemKey: ProblemKey =
    problem === 'busy'
      ? 'common.this.account.has.an.action.running.in'
      : problem === 'locks-unavailable'
        ? 'common.this.browser.has.no.cross.tab.mutation'
        : problem === 'connection'
          ? 'common.the.connection.ended.before.the.service.confirmed'
          : problem === 'lookup'
            ? 'common.the.original.outcome.lookup.could.not.be'
            : problem === 'changed' || problem === 'pending'
              ? 'common.the.account.or.pending.request.changed.review'
              : 'common.recovery.storage.is.unavailable.no.action.was';
  const request = admitted.current;
  const reviewing = live() && request && request.epoch === interaction.current && !operation.current ? request : null;
  void revision;
  return {
    stage,
    isCurrent: live,
    viewIdentity,
    unresolvedId: saved.status === 'present' && !snapshot.known && !operation.current ? saved.value.id : null,
    result: shown.result,
    disabled: Boolean(operation.current || saved.status !== 'empty' || snapshot.known || !live()),
    /** What the room draws: the wait, the failure, the success line, the journal's notices and the review. */
    view: {
      userId,
      language,
      running: Boolean(operation.current),
      failure,
      presentation,
      copy,
      problem,
      problemKey,
      success: shown.success,
      known: snapshot.known,
      saved,
      canRecover: Boolean(recovery),
      cleanup,
      recoverOriginal,
      redraw,
      reviewing,
      dismiss,
      send,
    },
  };
}
type ProblemKey =
  | 'common.this.account.has.an.action.running.in'
  | 'common.this.browser.has.no.cross.tab.mutation'
  | 'common.the.connection.ended.before.the.service.confirmed'
  | 'common.the.original.outcome.lookup.could.not.be'
  | 'common.the.account.or.pending.request.changed.review'
  | 'common.recovery.storage.is.unavailable.no.action.was';
export type ActionState = ReturnType<typeof useActionState>;
