import { useLayoutEffect, useRef, useState } from 'react';
import { useSession } from '../session/session';
import { Button, Dialog, Field, Panel } from '../../shared/ui';
import type { ApiClient, ApiResult } from '../../shared/api';
import { navigate } from '../../app/location';
import { safeCardSvg } from './Blueprint';
import { blueprintSharedCardCopy } from './blueprint-shared-card-copy';
import {
  currentSharedCardRoute,
  sharedCardDimensions,
  sharedCardFailure,
  sharedCardHref,
  sharedCardResponse,
  sharedCardRoute,
  sharedCardSelection,
  subscribeSharedCardRoute,
  type SharedCard,
  type SharedCardSelection,
} from './blueprint-shared-card-contract';
import './blueprint-shared-card.css';

type Lease = { api: ApiClient; actor: string | null; session: object | null; route: ReturnType<typeof currentSharedCardRoute> };
function useViewerLease(invalidate: () => void) {
  const { api, userId, session } = useSession();
  const [, refresh] = useState(0);
  const current = useRef<Lease | null>(null),
    mounted = useRef(false),
    revoke = useRef(invalidate);
  revoke.current = invalidate;
  const route = currentSharedCardRoute();
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
    const unsubscribe = subscribeSharedCardRoute(() => {
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
    mounted.current && current.current === lease && !!lease.actor && lease.api.canWrite() && currentSharedCardRoute() === lease.route;
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
      result = await lease.api.query('blueprint', 'cardOf', intent.selection, sharedCardResponse(intent.selection), {
        signal: intent.controller.signal,
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
    <section data-testid="blueprint-shared" className="blueprint-shared" aria-label={t('title')} lang={languageFor('title')}>
      <Panel title={t('title')}>
        <p className="muted">{t('intro')}</p>
        <form
          className="blueprint-shared-controls"
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
          <label className="field">
            <span>{t('size')}</span>
            <select value={draft.size} onChange={(event) => edit({ ...draft, size: event.target.value })}>
              <option value="portrait">{t('portrait')}</option>
              <option value="landscape">{t('landscape')}</option>
            </select>
          </label>
          <Button type="submit" disabled={!parsed.success || !lease.actor}>
            {t('open')}
          </Button>
        </form>
        {selected && dimensions && (
          <div className={`blueprint-shared-result ${selected.size}`}>
            <div data-testid="blueprint-shared-context" className="blueprint-shared-context">
              <span className="muted">{t('requested')}</span>
              <code>{selected.userId}</code>
              <span className="muted">
                {t(selected.size)} · {dimensions.width} × {dimensions.height}
              </span>
            </div>
            {visible && view.status === 'loading' && <p role="status">{t('loading')}</p>}
            {artifact && (
              <>
                <img
                  data-testid="blueprint-shared-image"
                  className="blueprint-shared-image"
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
                <div data-testid="blueprint-shared-actions" className="blueprint-shared-actions">
                  <Button
                    variant="secondary"
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
                    variant="secondary"
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
                    <aside className="blueprint-shared-note">
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
                    <p className="muted">{t('pngAvailable')}</p>
                  )}
                  <p className="muted">{t('original')}</p>
                </div>
              </>
            )}
            {failure && (
              <div data-testid="blueprint-shared-failure" className="blueprint-shared-failure" role="status">
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
                    className="button button--secondary"
                    href={`/login?redirect=${encodeURIComponent(new URL(lease.route.href).pathname + new URL(lease.route.href).search)}`}
                  >
                    {t('signIn')}
                  </a>
                ) : (
                  <Button
                    variant="secondary"
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
      </Panel>
      {modal && (
        <Dialog
          title={t('full')}
          onClose={() => {
            if (fullRef.current !== modal || !artifactCurrent(modal.artifact)) return;
            fullRef.current = null;
            setFull(null);
          }}
        >
          <div className="blueprint-shared-full" tabIndex={0} role="region" aria-label={t('alt')}>
            <img src={modal.artifact.url} alt={t('alt')} width={modal.artifact.card.width} height={modal.artifact.card.height} />
          </div>
        </Dialog>
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
      variant="secondary"
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
