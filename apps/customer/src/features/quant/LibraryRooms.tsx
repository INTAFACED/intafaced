import {
  QUANT_LIBRARY_TAGS,
  quantLibraryPageSchema,
  quantLineageSchema,
  quantListingPageSchema,
  quantListingPreviewSchema,
  type QuantLibraryTag,
  type QuantListingPage,
  type QuantListingPreview,
} from '@intafaced/contracts/quant-library';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Panel } from '../../shared/ui';
import { Read, Select, TextArea } from '../more/common';
import { preservePaperHref } from '../more/trade-context';
import { useApi } from '../session/session';
import { libraryCopy } from './library-copy';
import { QuantRooms } from './QuantRooms';
import { libraryRefusal } from './StrategyPublish';
import { useLastReady } from './StrategyTeam';
import './algo.css';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Refusal = { code: string; text: string };
const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');
/** How many listings one page of the library reads. A page size, not a product limit. */
const PAGE = 20;

/** The strategy library (AL-library-02): open and protected listings in registration order, filtered by tag. */
export function LibraryRoom({ paper }: { paper: boolean }) {
  const { t } = libraryCopy.useCopy();
  const [tag, setTag] = useState<QuantLibraryTag | ''>('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <Panel title={t('libraryTitle')}>
        <div data-testid="quant-library" data-tag={tag}>
          <p className="muted">{t('libraryIntro')}</p>
          <Select
            label={t('filterTag')}
            value={tag}
            onChange={(value) => {
              setTag(QUANT_LIBRARY_TAGS.find((row) => row === value) ?? '');
              setCursors([null]);
            }}
            options={[{ value: '', label: t('allTags') }, ...QUANT_LIBRARY_TAGS.map((row) => ({ value: row, label: t(`tag_${row}`) }))]}
          />
          {cursors.map((cursor, i) => (
            <LibraryPage
              key={`${tag}:${cursor ?? 'first'}`}
              tag={tag || null}
              cursor={cursor}
              first={i === 0}
              last={i === cursors.length - 1}
              paper={paper}
              onMore={(next) => setCursors((prev) => [...prev, next])}
            />
          ))}
        </div>
      </Panel>
    </>
  );
}

function LibraryPage({
  tag,
  cursor,
  first,
  last,
  paper,
  onMore,
}: {
  tag: QuantLibraryTag | null;
  cursor: string | null;
  first: boolean;
  last: boolean;
  paper: boolean;
  onMore: (cursor: string) => void;
}) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const page = useResource(
    (signal) => api.query('quant', 'library.browse', { tag, limit: PAGE, cursor }, quantLibraryPageSchema, { signal }),
    `quant-library:${tag ?? ''}:${cursor ?? ''}`,
  );
  return (
    <Read resource={page.resource} retry={page.reload}>
      {(data) => (
        <>
          {data.entries.length === 0 && first ? (
            <EmptyState title={t('empty')} />
          ) : (
            <DataTable
              label={t('libraryTitle')}
              headers={[t('colTitle'), t('colTags'), t('colVisibility'), t('colLicence'), t('colListed')]}
            >
              {data.entries.map((row) => (
                <tr key={row.listingId} data-testid="quant-library-row" data-listing-id={row.listingId} data-tags={row.tags.join(' ')}>
                  <td lang="und">
                    <a className="text-link" href={preservePaperHref(`/quant/library/${encodeURIComponent(row.listingId)}`, paper)}>
                      {row.title}
                    </a>
                  </td>
                  <td>{row.tags.map((tagId) => t(`tag_${tagId}`)).join(', ')}</td>
                  <td>{t(`visibility_${row.visibility}`)}</td>
                  <td lang="und">{row.licence}</td>
                  <td lang="zxx">{utcText(row.listedAt)}</td>
                </tr>
              ))}
            </DataTable>
          )}
          {last && data.nextCursor && (
            <Button variant="secondary" onClick={() => onMore(data.nextCursor!)}>
              {t('more')}
            </Button>
          )}
        </>
      )}
    </Read>
  );
}

/** One listing (AL-library-02): an invite-only one shows its title and Request access until the owner grants it. */
export function ListingRoom({ listingId, paper }: { listingId: string; paper: boolean }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const preview = useResource(
    (signal) => api.query('quant', 'library.preview', { listingId }, quantListingPreviewSchema, { signal }),
    `quant-listing-preview:${listingId}:${revision}`,
  );
  const kept = useLastReady(preview.resource);
  return (
    <>
      <QuantRooms active="strategies" paper={paper} />
      <p>
        <a className="text-link" href={preservePaperHref('/quant/library', paper)}>
          {t('back')}
        </a>
      </p>
      {kept ? (
        <Panel title={kept.title}>
          <div data-testid="quant-listing" data-listing-id={kept.listingId} data-visibility={kept.visibility} data-access={kept.access}>
            {kept.access === 'none' || kept.access === 'requested' ? (
              <RequestAccess preview={kept} onChange={() => setRevision((n) => n + 1)} />
            ) : (
              <ListingBody listingId={listingId} paper={paper} />
            )}
          </div>
        </Panel>
      ) : (
        <Read resource={preview.resource} retry={preview.reload}>
          {() => null}
        </Read>
      )}
    </>
  );
}

function RequestAccess({ preview, onChange }: { preview: QuantListingPreview; onChange: () => void }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [failure, setFailure] = useState<Failed | null>(null);
  async function request() {
    setFailure(null);
    const res = await api.mutate(
      'quant',
      'library.request',
      { listingId: preview.listingId, seq: preview.rows },
      quantListingPreviewSchema,
    );
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
        <Button onClick={() => void request()}>{t('requestAccess')}</Button>
      )}
      {failure && <Failure result={failure} />}
    </div>
  );
}

function ListingBody({ listingId, paper }: { listingId: string; paper: boolean }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const page = useResource(
    (signal) => api.query('quant', 'library.get', { listingId }, quantListingPageSchema, { signal }),
    `quant-listing:${listingId}:${revision}`,
  );
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
      <Read resource={page.resource} retry={page.reload}>
        {() => null}
      </Read>
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
            <p className="muted">{r.label}</p>
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
          <pre lang="zxx" className="quant-source" tabIndex={0} data-testid="quant-listing-source">
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
    const res = await api.mutate('quant', 'library.clone', { listingId: listing.listingId }, quantLineageSchema);
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
      <Button onClick={() => void clone()} disabled={busy}>
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
            className="text-link"
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
      {failure && <Failure result={failure} />}
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
    const res = await api.mutate('quant', 'library.review', { listingId: listing.listingId, text }, quantListingPageSchema);
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
        <EmptyState title={t('noReviews')} />
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
          <TextArea label={t('reviewText')} value={text} onChange={setText} maxLength={2000} />
          <Button type="submit" disabled={busy}>
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
          {failure && <Failure result={failure} />}
        </form>
      )}
    </section>
  );
}
