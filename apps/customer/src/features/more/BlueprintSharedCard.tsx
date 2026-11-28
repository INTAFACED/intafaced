// volt-room: /blueprint/shared/:cardId
import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Field } from '@intafaced/ui/lit';
import { ReadingTemplate, SelectField, Sheet } from '@intafaced/ui/lit/templates';
import { useSession } from '../session';
import type { ApiClient, ApiResult } from '../../shared/api';
import { navigate } from '../../app/location';
import { BLUEPRINT_CARD_OF } from '@intafaced/contracts/blueprint-procedures';
import { safeCardSvg } from './blueprint-card-svg';
import { blueprintSharedCardCopy } from './blueprint-shared-card-copy';
import { t as moreText } from './copy';
import { moreRoomRoutesCopy } from './more-room-routes-copy';
import { preservePaperHref } from './trade-context';
import { currentRoute, subscribeRoute } from '../../shared/route-watch';
import {
  sharedCardDimensions,
  sharedCardFailure,
  sharedCardHref,
  sharedCardMatches,
  sharedCardRoute,
  sharedCardSelection,
  type SharedCard,
  type SharedCardSelection,
} from './blueprint-shared-card-contract';

type Lease = { api: ApiClient; actor: string | null; session: object | null; route: ReturnType<typeof currentRoute> };
function useViewerLease(invalidate: () => void) {
  const { api, userId, session } = useSession();
  const [, refresh] = useState(0);
  const current = useRef<Lease | null>(null),
    mounted = useRef(false),
    revoke = useRef(invalidate);
  revoke.current = invalidate;
  const route = currentRoute();
  if (
    !current.current ||
    current.current.api !== api ||
    current.current.actor !== userId ||
    current.current.session !== session ||
    current.current.route !== route
  ) {
    current.current = { api, actor: userId, session, route };
  }
  const lease = current.current;
  useLayoutEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeRoute(() => {
      current.current = null;
      revoke.current();
      refresh((n) => n + 1);
    });
    return () => {
      mounted.current = false;
      current.current = null;
      unsubscribe();
      revoke.current();
    };
  }, []);
  // canWrite is the synchronous client/session identity lease, not a service permission.
  const admits = () =>
    mounted.current && current.current === lease && !!lease.actor && lease.api.canWrite() && currentRoute() === lease.route;
  return { lease, admits };
}
type Intent = { selection: Readonly<SharedCardSelection>; lease: Lease; controller: AbortController };
type Artifact = { intent: Intent; card: SharedCard; url: string };
type View =
  | { status: 'idle' }
  | { status: 'loading'; intent: Intent }
  | { status: 'ready'; artifact: Artifact }
  | { status: 'failed'; intent: Intent; failure: ReturnType<typeof sharedCardFailure> | 'unsafe'; code?: string };
type Draft = { userId: string; size: string };

/**
 * /blueprint/shared/:cardId on the reading template: a Blueprint card someone shared, read by its account and size. The
 * person's own Blueprint, its crew and its erasure stay in the Blueprint room, linked here.
 */
export function BlueprintSharedRoom({ path, paper }: { path: string; paper: boolean }) {
  const routes = moreRoomRoutesCopy.useCopy();
  return (
    <div data-room="blueprint-shared">
      <ReadingTemplate
        title={routes.t('sharedCard')}
        description={moreText('moreroutes.a.profile.you.can.keep.private.share')}
        state={{ kind: 'ready' }}
        body={<BlueprintSharedCard path={path} />}
        related={
          <p>
            <a className="lt-link" href={preservePaperHref('/blueprint', paper)}>
              {routes.t('open')}
            </a>
          </p>
        }
      />
    </div>
  );
}

export function BlueprintSharedCard({ path }: { path: string }) {
  const { t, languageFor } = blueprintSharedCardCopy.useCopy();
  const initial = sharedCardRoute(path);
  const [draft, setDraft] = useState<Draft>(() => initial.selection ?? { userId: '', size: 'portrait' });
  const draftRef = useRef(draft),
    intentRef = useRef<Intent | null>(null),
    artifactRef = useRef<Artifact | null>(null);
  const [view, setView] = useState<View>({ status: 'idle' });
  const [invalid, setInvalid] = useState(initial.invalid);
  const [full, setFull] = useState<{ artifact: Artifact } | null>(null),
    fullRef = useRef(full);
  function discard() {
    intentRef.current?.controller.abort();
    intentRef.current = null;
    if (artifactRef.current) URL.revokeObjectURL(artifactRef.current.url);
    artifactRef.current = null;
    fullRef.current = null;
  }
  const { lease, admits } = useViewerLease(discard);
  const draftLease = useRef<Lease | null>(null),
    appliedHref = useRef<string | null>(null);
  const previousLease = useRef(lease);
  if (previousLease.current !== lease) {
    discard();
    previousLease.current = lease;
  }
  const draftCurrent = () => admits() && draftRef.current === draft;
  const intentCurrent = (intent: Intent) => admits() && intent.lease === lease && intentRef.current === intent;
  const artifactCurrent = (artifact: Artifact) => intentCurrent(artifact.intent) && artifactRef.current === artifact;

  async function read(selection: SharedCardSelection) {
    if (!admits()) return;
    draftLease.current = lease;
    discard();
    const intent: Intent = { selection: Object.freeze({ ...selection }), lease, controller: new AbortController() };
    intentRef.current = intent;
    setFull(null);
    setInvalid(false);
    setView({ status: 'loading', intent });
    let result: ApiResult<SharedCard>;
    try {
      result = await lease.api.call(BLUEPRINT_CARD_OF, intent.selection, {
        signal: intent.controller.signal,
        accept: sharedCardMatches(intent.selection),
      });
    } catch {
      result = { ok: false, reason: 'unreachable', message: '' };
    }
    if (!intentCurrent(intent)) return;
    if (!result.ok) {
      setView({ status: 'failed', intent, failure: sharedCardFailure(result), code: result.code });
      return;
    }
    if (!safeCardSvg(result.data.svg)) {
      setView({ status: 'failed', intent, failure: 'unsafe' });
      return;
    }
    const url = URL.createObjectURL(new Blob([result.data.svg], { type: 'image/svg+xml;charset=utf-8' }));
    if (!intentCurrent(intent)) {
      URL.revokeObjectURL(url);
      return;
    }
    const artifact = { intent, card: result.data, url };
    artifactRef.current = artifact;
    setView({ status: 'ready', artifact });
  }
  useLayoutEffect(() => {
    if (!admits()) return;
    const departed = appliedHref.current !== lease.route.href;
    appliedHref.current = lease.route.href;
    // A fresh edit or read under this lease already owns the current draft.
    const cleanup = () => {
      if (intentRef.current?.lease === lease) discard();
    };
    if (draftLease.current === lease) return cleanup;
    draftLease.current = lease;
    const route = sharedCardRoute(lease.route.href);
    discard();
    const next = route.selection ?? { userId: '', size: 'portrait' };
    draftRef.current = next;
    setDraft(next);
    setFull(null);
    setView({ status: 'idle' });
    setInvalid(route.invalid);
    // An observed URL A→B→A retires its old intent without replaying it.
    if (departed && route.selection) void read(route.selection);
    return cleanup;
  }, [lease]);

  function edit(next: Draft) {
    if (!draftCurrent()) return;
    draftLease.current = lease;
    discard();
    draftRef.current = next;
    setDraft(next);
    setView({ status: 'idle' });
    setFull(null);
    setInvalid(false);
  }
  const visible = view.status === 'ready' ? artifactCurrent(view.artifact) : view.status === 'idle' || intentCurrent(view.intent);
  const selected =
    visible && view.status !== 'idle' ? (view.status === 'ready' ? view.artifact.intent.selection : view.intent.selection) : null;
  const dimensions = selected ? sharedCardDimensions[selected.size] : null;
  const artifact = visible && view.status === 'ready' ? view.artifact : null;
  const failure = visible && view.status === 'failed' ? view : null;
  const modal = full && fullRef.current === full && artifactCurrent(full.artifact) ? full : null;
  const parsed = sharedCardSelection.safeParse(draft);
  return (
    <section aria-labelledby="blueprint-shared-title" data-blueprint-shared lang={languageFor('title')}>
      <h2 id="blueprint-shared-title">{t('title')}</h2>
      <p>{t('intro')}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!draftCurrent()) return;
          const selection = sharedCardSelection.safeParse(draft);
          if (!selection.success) {
            setInvalid(true);
            return;
          }
          const href = sharedCardHref(selection.data);
          const current = new URL(lease.route.href);
          if (current.pathname + current.search + current.hash !== href) {
            // Navigation retires this lease; the new route dispatches exactly once.
            navigate(href, true);
            return;
          }
          void read(selection.data);
        }}
      >
        <Field
          label={t('account')}
          value={draft.userId}
          autoComplete="off"
          spellCheck={false}
          maxLength={36}
          onChange={(event) => edit({ ...draft, userId: event.target.value })}
          error={invalid ? t('invalid') : undefined}
        />
        <SelectField
          label={t('size')}
          value={draft.size}
          onChange={(size) => edit({ ...draft, size })}
          options={[
            { value: 'portrait', label: t('portrait') },
            { value: 'landscape', label: t('landscape') },
          ]}
        />
        <Button tone="primary" type="submit" disabled={!parsed.success || !lease.actor}>
          {t('open')}
        </Button>
      </form>
      {selected && dimensions && (
        <div data-size={selected.size}>
          <p data-part="context">
            <span>{t('requested')}</span> <code>{selected.userId}</code>{' '}
            <span>
              {t(selected.size)} · {dimensions.width} × {dimensions.height}
            </span>
          </p>
          {visible && view.status === 'loading' && <p role="status">{t('loading')}</p>}
          {artifact && (
            <>
              <img
                data-part="image"
                src={artifact.url}
                alt={t('alt')}
                width={artifact.card.width}
                height={artifact.card.height}
                onError={() => {
                  if (!artifactCurrent(artifact)) return;
                  URL.revokeObjectURL(artifact.url);
                  artifactRef.current = null;
                  fullRef.current = null;
                  setFull(null);
                  setView({ status: 'failed', intent: artifact.intent, failure: 'invalidResponse' });
                }}
              />
              <div className="lt-actions" data-part="actions">
                <Button
                  tone="secondary"
                  onClick={() => {
                    if (!artifactCurrent(artifact)) return;
                    const opened = { artifact };
                    fullRef.current = opened;
                    setFull(opened);
                  }}
                >
                  {t('full')}
                </Button>
                <Button
                  tone="secondary"
                  onClick={() => {
                    if (!artifactCurrent(artifact)) return;
                    const link = document.createElement('a');
                    link.href = artifact.url;
                    link.download = `identity-blueprint-${artifact.intent.selection.size}.svg`;
                    link.click();
                  }}
                >
                  {t('download')}
                </Button>
                {artifact.card.raster.status === 'unavailable' ? (
                  <aside>
                    <strong>{t('png')}</strong>
                    <p>
                      {t(
                        artifact.card.raster.code === 'blueprint.card_renderer_unconfigured'
                          ? 'pngUnconfigured'
                          : artifact.card.raster.code === 'blueprint.card_renderer_unreachable'
                            ? 'pngUnreachable'
                            : 'pngProtocol',
                      )}
                    </p>
                  </aside>
                ) : (
                  <p>{t('pngAvailable')}</p>
                )}
                <p>{t('original')}</p>
              </div>
            </>
          )}
          {failure && (
            <div role="status" data-part="failure">
              <h3>{t(failure.failure === 'unsafe' ? 'invalidResponse' : failure.failure)}</h3>
              <p>
                {t(
                  failure.failure === 'unavailable'
                    ? 'unavailableDetail'
                    : failure.failure === 'unsafe'
                      ? 'unsafe'
                      : failure.failure === 'forbidden'
                        ? 'forbiddenDetail'
                        : failure.failure === 'routeUnavailable'
                          ? 'routeDetail'
                          : failure.failure === 'invalidResponse'
                            ? 'invalidResponseDetail'
                            : failure.failure === 'unauthorized'
                              ? 'unauthorizedDetail'
                              : 'failedDetail',
                )}
              </p>
              {failure.code && failure.failure !== 'unavailable' && <code>{failure.code}</code>}
              {failure.failure === 'unauthorized' ? (
                <a
                  className="lt-button lt-button-secondary"
                  href={`/login?redirect=${encodeURIComponent(new URL(lease.route.href).pathname + new URL(lease.route.href).search)}`}
                >
                  {t('signIn')}
                </a>
              ) : (
                <Button
                  tone="secondary"
                  onClick={() => {
                    if (intentCurrent(failure.intent)) void read(failure.intent.selection);
                  }}
                >
                  {t('retry')}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {modal && (
        <Sheet
          open
          title={t('full')}
          onClose={() => {
            if (fullRef.current !== modal || !artifactCurrent(modal.artifact)) return;
            fullRef.current = null;
            setFull(null);
          }}
        >
          <div tabIndex={0} role="region" aria-label={t('alt')}>
            <img src={modal.artifact.url} alt={t('alt')} width={modal.artifact.card.width} height={modal.artifact.card.height} />
          </div>
        </Sheet>
      )}
    </section>
  );
}

export function BlueprintMentorCardAction({ subject, available }: { subject: string; available: () => boolean }) {
  const { t, languageFor } = blueprintSharedCardCopy.useCopy();
  const { lease, admits } = useViewerLease(() => {});
  const current = useRef({ subject, available });
  current.current = { subject, available };
  const captured = current.current;
  return (
    <Button
      tone="secondary"
      lang={languageFor('view')}
      onClick={() => {
        if (!admits() || current.current !== captured || !captured.available()) return;
        if (!sharedCardSelection.safeParse({ userId: subject, size: 'portrait' }).success) return;
        navigate(`/blueprint?subject=${encodeURIComponent(subject)}&size=portrait`);
      }}
    >
      {t('view')}
    </Button>
  );
}
