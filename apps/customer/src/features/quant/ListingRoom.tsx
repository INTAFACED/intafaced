import { type QuantListingPage, type QuantListingPreview } from '@intafaced/contracts/quant-library';
import {
  QUANT_LIBRARY_CLONE,
  QUANT_LIBRARY_GET,
  QUANT_LIBRARY_PREVIEW,
  QUANT_LIBRARY_REQUEST,
  QUANT_LIBRARY_REVIEW,
} from '@intafaced/contracts/quant-library-procedures';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { EmptyNote, FailureNote, KitRead, preservePaperHref, Section } from '../more';
import { useApi } from '../session';
import { libraryCopy } from './library-copy';
import { QuantRooms } from './QuantRooms';
import { libraryRefusal } from './StrategyPublish';
import { useLastReady } from './StrategyTeam';
import { Button } from '@intafaced/ui/lit';
import { ReadingTemplate, TextAreaField } from '@intafaced/ui/lit/templates';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Refusal = { code: string; text: string };
const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');

/**
 * /quant/library/:listingId on the reading template: one listing (AL-library-02, J-algo-dev-09). An invite-only one
 * shows its title and Request access until the owner grants it.
 */
export function ListingRoom({ listingId, paper }: { listingId: string; paper: boolean }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const preview = useResource(
    (signal) => api.call(QUANT_LIBRARY_PREVIEW, { listingId }, { signal }),
    `quant-listing-preview:${listingId}:${revision}`,
  );
  const kept = useLastReady(preview.resource);
  return (
    <ReadingTemplate
      title={t('libraryTitle')}
      description={t('libraryIntro')}
      state={{ kind: 'ready' }}
      meta={
        <>
          <QuantRooms active="strategies" paper={paper} />
          <p>
            <a className="lt-link" href={preservePaperHref('/quant/library', paper)}>
              {t('back')}
            </a>
          </p>
        </>
      }
      body={
        kept ? (
          <Section title={kept.title}>
            <div data-testid="quant-listing" data-listing-id={kept.listingId} data-visibility={kept.visibility} data-access={kept.access}>
              {kept.access === 'none' || kept.access === 'requested' ? (
                <RequestAccess preview={kept} onChange={() => setRevision((n) => n + 1)} />
              ) : (
                <ListingBody listingId={listingId} paper={paper} />
              )}
            </div>
          </Section>
        ) : (
          <KitRead resource={preview.resource} retry={preview.reload}>
            {() => null}
          </KitRead>
        )
      }
    />
  );
}

function RequestAccess({ preview, onChange }: { preview: QuantListingPreview; onChange: () => void }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [failure, setFailure] = useState<Failed | null>(null);
  async function request() {
    setFailure(null);
    const res = await api.call(QUANT_LIBRARY_REQUEST, { listingId: preview.listingId, seq: preview.rows });
    if (!res.ok) return setFailure(res);
    onChange();
  }
  return (
    <div data-testid="quant-listing-locked">
      <p>{t('inviteOnly')}</p>
      {preview.access === 'requested' ? (
        <p role="status" data-testid="quant-access-requested">
          {t('requested')}
        </p>
      ) : (
        <Button tone="primary" onClick={() => void request()}>
          {t('requestAccess')}
        </Button>
      )}
      {failure && <FailureNote result={failure} />}
    </div>
  );
}

function ListingBody({ listingId, paper }: { listingId: string; paper: boolean }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const page = useResource((signal) => api.call(QUANT_LIBRARY_GET, { listingId }, { signal }), `quant-listing:${listingId}:${revision}`);
  const kept = useLastReady(page.resource);
  if (page.resource.status === 'failed') {
    const named = libraryRefusal(page.resource.failure, t);
    if (named)
      return (
        <p role="alert" data-testid="quant-listing-refusal" data-code={named.code}>
          {named.code === 'quant.listing_access_denied' ? `${t('revoked')} ${named.text}` : named.text}
        </p>
      );
  }
  if (!kept)
    return (
      <KitRead resource={page.resource} retry={page.reload}>
        {() => null}
      </KitRead>
    );
  return <ListingDetail listing={kept} paper={paper} onChange={() => setRevision((n) => n + 1)} />;
}

function ListingDetail({ listing, paper, onChange }: { listing: QuantListingPage; paper: boolean; onChange: () => void }) {
  const { t } = libraryCopy.useCopy();
  const r = listing.result;
  return (
    <div data-testid="quant-listing-page" data-stale={listing.stale} data-mine={listing.mine}>
      <p data-testid="quant-listing-by">
        {t('by', { owner: listing.ownerId, version: String(listing.strategyVersion), licence: listing.licence })}
      </p>
      <p>{listing.tags.map((tag) => t(`tag_${tag}`)).join(', ')}</p>
      {listing.stale && <p data-testid="quant-listing-stale">{t('staleListing')}</p>}
      <p lang="und" data-testid="quant-listing-description">
        {listing.description}
      </p>
      <section aria-label={t('resultTitle')} data-testid="quant-listing-result" data-run-id={r?.runId ?? ''}>
        <h4>{t('resultTitle')}</h4>
        {r ? (
          <>
            <p>{r.label}</p>
            <p lang="zxx">
              {t('resultLine', {
                symbol: r.symbol,
                from: utcText(r.from),
                to: utcText(r.to),
                start: r.startCash,
                net: r.net,
                end: r.endEquity,
                trades: String(r.trades),
              })}
            </p>
          </>
        ) : (
          <p>{t('noResult')}</p>
        )}
      </section>
      <section aria-label={t('sourceTitle', { version: String(listing.strategyVersion) })} data-testid="quant-listing-source-panel">
        <h4>{t('sourceTitle', { version: String(listing.strategyVersion) })}</h4>
        {listing.source === null ? (
          <p data-testid="quant-listing-source-protected">{t('sourceProtected')}</p>
        ) : (
          <pre lang="zxx" className="lt-code" tabIndex={0} data-testid="quant-listing-source">
            {listing.source}
          </pre>
        )}
      </section>
      {!listing.mine && <CloneButton listing={listing} paper={paper} onChange={onChange} />}
      <Reviews listing={listing} onChange={onChange} />
    </div>
  );
}

function CloneButton({ listing, paper, onChange }: { listing: QuantListingPage; paper: boolean; onChange: () => void }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function clone() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setRefused(null);
    setFailure(null);
    const res = await api.call(QUANT_LIBRARY_CLONE, { listingId: listing.listingId });
    setBusy(false);
    if (res.ok) {
      setNote(t('cloned'));
      onChange();
      return;
    }
    const named = libraryRefusal(res, t);
    if (named) setRefused(named);
    else setFailure(res);
  }
  return (
    <section data-testid="quant-listing-clone">
      <Button tone="primary" onClick={() => void clone()} disabled={busy}>
        {t('clone')}
      </Button>
      {note && (
        <p role="status" data-testid="quant-clone-note">
          {note}
        </p>
      )}
      {listing.clone && (
        <p>
          <a
            className="lt-link"
            data-testid="quant-clone-link"
            data-strategy-id={listing.clone.strategyId}
            href={preservePaperHref(`/quant/strategies/${encodeURIComponent(listing.clone.strategyId)}`, paper)}
          >
            {t('openClone')}
          </a>
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-clone-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <FailureNote result={failure} />}
    </section>
  );
}

function Reviews({ listing, onChange }: { listing: QuantListingPage; onChange: () => void }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  async function send() {
    if (busy) return;
    setBusy(true);
    setNote(null);
    setRefused(null);
    setFailure(null);
    const res = await api.call(QUANT_LIBRARY_REVIEW, { listingId: listing.listingId, text });
    setBusy(false);
    if (res.ok) {
      setNote(t('reviewSaved'));
      onChange();
      return;
    }
    const named = libraryRefusal(res, t);
    if (named) setRefused(named);
    else setFailure(res);
  }
  return (
    <section aria-label={t('reviewsTitle')} data-testid="quant-listing-reviews">
      <h4>{t('reviewsTitle')}</h4>
      {listing.reviews.length === 0 ? (
        <EmptyNote title={t('noReviews')} />
      ) : (
        <ul>
          {listing.reviews.map((row) => (
            <li key={row.reviewerId} data-testid="quant-listing-review" data-reviewer={row.reviewerId}>
              <span lang="zxx">{utcText(row.createdAt)}</span> <span lang="und">{row.text}</span>
            </li>
          ))}
        </ul>
      )}
      {!listing.mine && (
        <form
          data-testid="quant-review-form"
          aria-label={t('reviewText')}
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <TextAreaField label={t('reviewText')} value={text} onChange={setText} maxLength={2000} />
          <Button tone="primary" type="submit" disabled={busy}>
            {t('sendReview')}
          </Button>
          {note && (
            <p role="status" data-testid="quant-review-note">
              {note}
            </p>
          )}
          {refused && (
            <p role="alert" data-testid="quant-review-refusal" data-code={refused.code}>
              {refused.text}
            </p>
          )}
          {failure && <FailureNote result={failure} />}
        </form>
      )}
    </section>
  );
}
