import { useState } from 'react';
import type { StatusPage } from './status';
import { statusCopy } from './status-copy';

/** Where the service draws the badge; Edge serves it on the site's own origin. */
export const statusBadgeUrl = (origin: string, componentId: string | null) =>
  `${origin}/api/notify/status/badge.svg${componentId ? `?component=${encodeURIComponent(componentId)}` : ''}`;

const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * "Share this status" on /status (SP-status-05): an image another page can show, for the whole page or one component,
 * with a plain link back here. Image and link only, never a frame.
 */
export function StatusBadgeShare({ components }: { components: StatusPage['components'] }) {
  const copy = statusCopy.useCopy();
  const [componentId, setComponentId] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean | 'failed'>(false);
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const image = statusBadgeUrl(origin, componentId);
  const alt = componentId ? `${components.find((c) => c.id === componentId)?.name ?? componentId} status` : copy.t('title');
  const snippet = `<a href="${escapeAttr(`${origin}/status`)}"><img src="${escapeAttr(image)}" alt="${escapeAttr(alt)}"></a>`;

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
    } catch {
      setCopied('failed');
    }
  }

  return (
    <section className="pub-card status-share" aria-labelledby="status-share" data-testid="status-share">
      <h2 id="status-share">{copy.t('shareTitle')}</h2>
      <p className="muted">{copy.t('shareLead')}</p>
      <label className="field">
        <span>{copy.t('shareWhat')}</span>
        <select
          value={componentId ?? ''}
          onChange={(event) => {
            setComponentId(event.target.value || null);
            setCopied(false);
          }}
        >
          <option value="">{copy.t('shareWholePage')}</option>
          {components.map((component) => (
            <option key={component.id} value={component.id}>
              {component.name}
            </option>
          ))}
        </select>
      </label>
      <p className="status-share__preview">
        <img src={image} alt={alt} data-testid="status-share-image" />
      </p>
      <label className="field">
        <span>{copy.t('shareImageLink')}</span>
        <input readOnly value={image} data-testid="status-share-url" onFocus={(event) => event.currentTarget.select()} />
      </label>
      <label className="field">
        <span>{copy.t('shareSnippet')}</span>
        <textarea readOnly rows={3} value={snippet} data-testid="status-share-snippet" onFocus={(event) => event.currentTarget.select()} />
      </label>
      <button type="button" className="button button--secondary" onClick={() => void copySnippet()}>
        {copied === true ? copy.t('shareCopied') : copy.t('shareCopy')}
      </button>
      {copied === 'failed' ? (
        <p role="alert" data-testid="status-share-copy-failed">
          {copy.t('shareCopyFailed')}
        </p>
      ) : null}
    </section>
  );
}
