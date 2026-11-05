import { useState } from 'react';
import { z } from 'zod';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, Loading } from '../../shared/ui';
import { useSession } from '../session/session';
import { SHARE_SURFACES, type ShareSurface as Surface } from '../public/share-visit';
import { shareSheetCopy as copy } from './share-sheet-copy';

// One-tap share (RC-campaigns-06, J-campaigns-05 #2): a signed share tag for the person's live invitation link, one per
// surface, and the visits each surface counted. The tag never makes a link; the link has its own reviewed request above.
// hand-declared-ok: svc-identity's affiliates procedures have no browser-safe schema in packages/contracts yet
const tagSchema = z.object({ tag: z.string().min(1), token: z.string().guid(), surface: z.enum(SHARE_SURFACES) });
const statsSchema = z.object({
  token: z.string().guid(),
  surfaces: z.array(z.object({ surface: z.enum(SHARE_SURFACES), visits: z.number().int().nonnegative() })),
});
type Failure = Extract<ApiResult<unknown>, { ok: false }>;

/** The address a tag opens: the invitation page, which counts the visit and then shows the invitation. */
export function shareTagHref(tag: string): string {
  return `${location.origin}/invite?tag=${encodeURIComponent(tag)}`;
}

export function ShareSheet({ surface = 'promotion' }: { surface?: Surface }) {
  const { userId } = useSession();
  return userId ? <OwnerShareSheet key={userId} surface={surface} /> : null;
}

function OwnerShareSheet({ surface }: { surface: Surface }) {
  const { api } = useSession();
  const { t, Copy } = copy.useCopy();
  const { resource, reload } = useResource(
    (signal) => api.query('identity', 'affiliates.shareStats', undefined, statsSchema, { signal }),
    'share-stats',
  );
  const [href, setHref] = useState<string | null>(null);
  const [refused, setRefused] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'shared' | 'sharedNative' | 'copyUnavailable' | null>(null);
  const noLink = resource.status === 'failed' && resource.failure.code === 'share.not_found';

  async function share() {
    setBusy(true);
    setRefused(null);
    setDone(null);
    // Safe to press again: the same link and surface always sign to the same tag.
    const answer = await api.mutate('identity', 'affiliates.shareTag', { surface }, tagSchema);
    setBusy(false);
    if (!answer.ok) {
      setRefused(answer);
      return;
    }
    const next = shareTagHref(answer.data.tag);
    setHref(next);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url: next, text: t('shareText') });
        setDone('sharedNative');
        return;
      } catch (err) {
        // The person closed the menu: nothing was shared, and nothing is copied behind their back. The link stays shown.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Any other failure of the menu falls back to the clipboard below.
      }
    }
    try {
      await navigator.clipboard.writeText(next);
      setDone('shared');
    } catch {
      setDone('copyUnavailable');
    }
  }

  return (
    <section className="promotions__link" aria-label={t('title')}>
      <h2>
        <Copy k="title" />
      </h2>
      <p className="muted">
        <Copy k="body" />
      </p>
      {noLink ? (
        <p role="status">
          <Copy k="noLink" />
        </p>
      ) : (
        <div className="promotions__actions">
          <Button disabled={busy} onClick={() => void share()}>
            <Copy k="share" />
          </Button>
        </div>
      )}
      {href && (
        <label className="field">
          <span>{t(`link_${surface}`)}</span>
          <input readOnly value={href} lang="zxx" />
        </label>
      )}
      {done && (
        <p role="status">
          <Copy k={done} />
        </p>
      )}
      {refused && (
        <div role="alert">
          <p>
            <Copy k={refused.code === 'share.key_unset' ? 'keyUnset' : refused.code === 'share.not_found' ? 'noLink' : 'refused'} />
          </p>
          {refused.code && (
            <p lang="zxx">
              HTTP {refused.status} · {refused.code}
            </p>
          )}
        </div>
      )}
      <h3>
        <Copy k="visits" />
      </h3>
      {resource.status === 'loading' ? (
        <Loading />
      ) : resource.status === 'ready' ? (
        <dl aria-label={t('visits')}>
          {resource.data.surfaces.map((row) => (
            <div className="promotions__visits" key={row.surface} data-testid={`share-visits-${row.surface}`}>
              <dt>{t(`surface_${row.surface}`)}</dt>
              <dd>
                <strong lang="zxx">{row.visits}</strong>
              </dd>
            </div>
          ))}
        </dl>
      ) : noLink ? null : (
        <p role="alert">
          <Copy k="statsFailed" /> {resource.failure.code && <span lang="zxx">{resource.failure.code}</span>}
        </p>
      )}
      <Button variant="secondary" onClick={reload}>
        <Copy k="refresh" />
      </Button>
    </section>
  );
}
