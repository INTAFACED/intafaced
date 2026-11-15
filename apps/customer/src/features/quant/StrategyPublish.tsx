import { type QuantStrategyDetail } from '@intafaced/contracts/quant-algo';
import {
  QUANT_LIBRARY_TAGS,
  QUANT_LISTING_VISIBILITIES,
  quantLibraryOptionsSchema,
  quantLineageReadSchema,
  quantListingCheckSchema,
  quantListingSchema,
  quantMyListingsSchema,
  type QuantLibraryOptions,
  type QuantLibraryTag,
  type QuantListing,
  type QuantListingCheck,
  type QuantListingVisibility,
} from '@intafaced/contracts/quant-library';
import { useState } from 'react';
import type { ApiResult } from '../../shared/api';
import { useResource } from '../../shared/resource';
import { Button, DataTable, EmptyState, Failure, Field, Loading } from '../../shared/ui';
import { Read, Select, TextArea } from '../more/common';
import { useApi } from '../session/session';
import { libraryCopy } from './library-copy';
import { refusalCode, useLastReady } from './StrategyTeam';

type Failed = Extract<ApiResult<unknown>, { ok: false }>;
type Refusal = { code: string; text: string };
const utcText = (iso: string) => iso.slice(0, 19).replace('T', ' ');
/** The detail after the code and the check name: `quant.listing_check_failed — claim — <detail>; nothing was listed`. */
const checkDetail = (result: Failed) =>
  result.message.replace(/^.*?quant\.[a-z_]+ — ([a-z]+ — )?/, '').replace(/; nothing was (listed|saved)\.?$/, '');

/** The library refusals this screen names; anything else is shown as the failure it is. */
export function libraryRefusal(result: Failed, t: ReturnType<typeof libraryCopy.useCopy>['t'], version?: number): Refusal | null {
  const code = refusalCode(result);
  if (code === 'quant.listing_check_failed')
    return {
      code,
      text:
        /claim — /.test(result.message) && version === undefined
          ? t('refusedClaim', { detail: checkDetail(result) })
          : t('refusedCheck', { detail: checkDetail(result) }),
    };
  if (code === 'quant.realism_checklist_unaccepted') return { code, text: t('refusedChecklist') };
  if (code === 'quant.listing_stale') return { code, text: t('refusedStale', { version: String(version ?? '') }) };
  if (code === 'quant.library_licences_unset') return { code, text: t('refusedLicences') };
  if (code === 'quant.realism_checklist_unset') return { code, text: t('refusedChecklistUnset') };
  if (code === 'quant.listing_source_protected') return { code, text: t('refusedProtected') };
  if (code === 'quant.review_needs_run') return { code, text: t('refusedNeedsRun') };
  if (code === 'quant.listing_access_denied') return { code, text: t('denied') };
  if (code === 'quant.listing_not_found') return { code, text: t('notFound') };
  return null;
}

/** Where a cloned strategy came from, on its own page; nothing for a strategy the person wrote. */
export function StrategyLineage({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const lineage = useResource(
    (signal) => api.query('quant', 'library.lineage', { strategyId: strategy.id }, quantLineageReadSchema, { signal }),
    `quant-lineage:${strategy.id}`,
  );
  if (lineage.resource.status !== 'ready' || !lineage.resource.data.lineage) return null;
  const row = lineage.resource.data.lineage;
  return (
    <p data-testid="quant-lineage" data-listing-id={row.listingId} data-source-version={row.sourceVersion}>
      {t('lineage', { title: row.listingTitle, version: String(row.sourceVersion), at: utcText(row.clonedAt) })}{' '}
      <a className="text-link" href={`/quant/library/${encodeURIComponent(row.listingId)}`}>
        {t('openListing', { title: row.listingTitle })}
      </a>
    </p>
  );
}

/** The owner's publish panel on a strategy's page (AL-library-01): the form, the checks, the checklist and their listings. */
export function StrategyPublish({ strategy }: { strategy: QuantStrategyDetail }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [revision, setRevision] = useState(0);
  const options = useResource(
    (signal) => api.query('quant', 'library.options', {}, quantLibraryOptionsSchema, { signal }),
    'quant-library-options',
  );
  const mine = useResource(
    (signal) => api.query('quant', 'library.mine', {}, quantMyListingsSchema, { signal }),
    `quant-library-mine:${revision}`,
  );
  const kept = useLastReady(mine.resource);
  const reload = () => setRevision((n) => n + 1);
  return (
    <section aria-label={t('publishTitle')} data-testid="quant-publish">
      <h3>{t('publishTitle')}</h3>
      <p className="muted">{t('publishIntro')}</p>
      <Read resource={options.resource} retry={options.reload}>
        {(data) => <PublishForm strategy={strategy} options={data} onPublished={reload} />}
      </Read>
      <h4>{t('listingsTitle')}</h4>
      {kept ? (
        <MyListings listings={kept.listings.filter((row) => row.strategyId === strategy.id)} onChange={reload} />
      ) : (
        <Read resource={mine.resource} retry={mine.reload}>
          {() => null}
        </Read>
      )}
    </section>
  );
}

function PublishForm({
  strategy,
  options,
  onPublished,
}: {
  strategy: QuantStrategyDetail;
  options: QuantLibraryOptions;
  onPublished: () => void;
}) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const newest = Math.max(...strategy.versions.map((row) => row.version));
  const [version, setVersion] = useState(newest);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState<QuantLibraryTag[]>([]);
  const [visibility, setVisibility] = useState<QuantListingVisibility>('open');
  const [licence, setLicence] = useState('');
  const [accepted, setAccepted] = useState<number[]>([]);
  const [checked, setChecked] = useState<QuantListingCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [failure, setFailure] = useState<Failed | null>(null);
  const details = { strategyId: strategy.id, strategyVersion: version, title, description, tags, visibility, licence };
  const items = options.checklist?.items ?? [];
  function begin() {
    setBusy(true);
    setNote(null);
    setRefused(null);
    setFailure(null);
  }
  async function runChecks() {
    if (busy) return;
    begin();
    const res = await api.query('quant', 'library.check', details, quantListingCheckSchema);
    setBusy(false);
    if (res.ok) return setChecked(res.data);
    setChecked(null);
    const named = libraryRefusal(res, t, version);
    if (named) setRefused(named);
    else setFailure(res);
  }
  async function publish() {
    if (busy) return;
    begin();
    const res = await api.mutate(
      'quant',
      'library.publish',
      {
        ...details,
        checklistVersion: options.checklist?.version ?? '',
        checklistAccepted: items.length > 0 && accepted.length === items.length,
      },
      quantListingSchema,
    );
    setBusy(false);
    if (res.ok) {
      setNote(t('published', { version: String(res.data.strategyVersion) }));
      onPublished();
      return;
    }
    const named = libraryRefusal(res, t, version);
    if (named) setRefused(named);
    else setFailure(res);
  }
  const toggleTag = (tag: QuantLibraryTag) => setTags((prev) => (prev.includes(tag) ? prev.filter((row) => row !== tag) : [...prev, tag]));
  return (
    <form
      data-testid="quant-publish-form"
      aria-label={t('publishTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void publish();
      }}
    >
      <Select
        label={t('version')}
        value={String(version)}
        onChange={(value) => setVersion(Number(value))}
        options={[...strategy.versions]
          .sort((a, b) => b.version - a.version)
          .map((row) => ({ value: String(row.version), label: t('versionOf', { version: String(row.version) }) }))}
      />
      <Field label={t('listingTitle')} value={title} maxLength={120} onChange={(event) => setTitle(event.currentTarget.value)} />
      <TextArea label={t('listingDescription')} value={description} onChange={setDescription} maxLength={4000} />
      <fieldset>
        <legend>{t('tags')}</legend>
        {QUANT_LIBRARY_TAGS.map((tag) => (
          <label key={tag} className="quant-check-line">
            <input className="quant-run-check" type="checkbox" checked={tags.includes(tag)} onChange={() => toggleTag(tag)} />{' '}
            {t(`tag_${tag}`)}
          </label>
        ))}
      </fieldset>
      <Select
        label={t('visibility')}
        value={visibility}
        onChange={(value) => setVisibility(QUANT_LISTING_VISIBILITIES.find((row) => row === value) ?? 'open')}
        options={QUANT_LISTING_VISIBILITIES.map((row) => ({ value: row, label: t(`visibility_${row}`) }))}
      />
      {options.licences ? (
        <Select
          label={t('licence')}
          value={licence}
          onChange={setLicence}
          options={[{ value: '', label: t('pickLicence') }, ...options.licences.map((row) => ({ value: row, label: row }))]}
        />
      ) : (
        <p data-testid="quant-licences-unset">{t('licencesUnset')}</p>
      )}
      <fieldset data-testid="quant-realism-checklist" data-version={options.checklist?.version ?? ''}>
        <legend>{t('checklistTitle')}</legend>
        {options.checklist ? (
          <>
            <p className="muted">{t('checklistVersion', { version: options.checklist.version })}</p>
            {items.map((item, i) => (
              <label key={i} className="quant-check-line">
                <input
                  className="quant-run-check"
                  type="checkbox"
                  checked={accepted.includes(i)}
                  onChange={() => setAccepted((prev) => (prev.includes(i) ? prev.filter((row) => row !== i) : [...prev, i]))}
                />{' '}
                <span lang="und">{item}</span>
              </label>
            ))}
          </>
        ) : (
          <p>{t('checklistUnset')}</p>
        )}
      </fieldset>
      <Button variant="secondary" onClick={() => void runChecks()} disabled={busy}>
        {t('runChecks')}
      </Button>{' '}
      <Button type="submit" disabled={busy}>
        {t('publish')}
      </Button>
      {busy && <Loading />}
      {checked && <CheckList reading={checked} />}
      {note && (
        <p role="status" data-testid="quant-publish-note">
          {note}
        </p>
      )}
      {refused && (
        <p role="alert" data-testid="quant-publish-refusal" data-code={refused.code}>
          {refused.text}
        </p>
      )}
      {failure && <Failure result={failure} />}
    </form>
  );
}

function CheckList({ reading }: { reading: QuantListingCheck }) {
  const { t } = libraryCopy.useCopy();
  return (
    <section
      aria-label={t('checksTitle')}
      data-testid="quant-listing-checks"
      data-passed={reading.passed}
      data-version={reading.strategyVersion}
    >
      <h4>{t('checksTitle')}</h4>
      <DataTable label={t('checksTitle')} headers={[t('checksTitle'), t('state'), '']}>
        {reading.checks.map((row) => (
          <tr key={row.id} data-testid="quant-listing-check" data-check={row.id} data-passed={row.passed}>
            <td>{t(`check_${row.id}`)}</td>
            <td>{row.passed ? t('passed') : t('failed')}</td>
            <td lang="und" data-testid="quant-listing-check-detail">
              {row.detail}
            </td>
          </tr>
        ))}
      </DataTable>
      <p data-testid="quant-listing-checks-summary">{reading.passed ? t('allPassed') : t('someFailed')}</p>
    </section>
  );
}

function MyListings({ listings, onChange }: { listings: QuantListing[]; onChange: () => void }) {
  const { t } = libraryCopy.useCopy();
  if (!listings.length) return <EmptyState title={t('noListings')} />;
  return (
    <>
      <DataTable label={t('listingsTitle')} headers={[t('colTitle'), t('version'), t('colVisibility'), t('listed'), t('state')]}>
        {listings.map((row) => (
          <tr
            key={row.listingId}
            data-testid="quant-my-listing"
            data-listing-id={row.listingId}
            data-version={row.strategyVersion}
            data-stale={row.stale}
          >
            <td lang="und">
              <a className="text-link" href={`/quant/library/${encodeURIComponent(row.listingId)}`}>
                {t('openListing', { title: row.title })}
              </a>
            </td>
            <td>{t('versionOf', { version: String(row.strategyVersion) })}</td>
            <td>{t(`visibility_${row.visibility}`)}</td>
            <td lang="zxx">{utcText(row.listedAt)}</td>
            <td data-testid="quant-my-listing-state">{row.stale ? t('stale', { head: String(row.headVersion ?? '') }) : t('current')}</td>
          </tr>
        ))}
      </DataTable>
      {listings
        .filter((row) => row.visibility === 'invite')
        .map((row) => (
          <ListingAccess key={row.listingId} listing={row} onChange={onChange} />
        ))}
    </>
  );
}

/** The owner's access list of one invite-only listing: who asked, who holds a grant, and grant or revoke. */
function ListingAccess({ listing, onChange }: { listing: QuantListing; onChange: () => void }) {
  const api = useApi();
  const { t } = libraryCopy.useCopy();
  const [userId, setUserId] = useState('');
  const [failure, setFailure] = useState<Failed | null>(null);
  async function act(action: 'grant' | 'revoke', user: string, rows: number) {
    setFailure(null);
    const res = await api.mutate(
      'quant',
      `library.${action}`,
      { listingId: listing.listingId, userId: user, seq: rows },
      quantListingSchema,
    );
    if (!res.ok) return setFailure(res);
    setUserId('');
    onChange();
  }
  return (
    <section aria-label={t('accessTitle', { title: listing.title })} data-testid="quant-listing-access" data-listing-id={listing.listingId}>
      <h5>{t('accessTitle', { title: listing.title })}</h5>
      {listing.access.length === 0 ? (
        <EmptyState title={t('noAccess')} />
      ) : (
        <DataTable label={t('accessTitle', { title: listing.title })} headers={[t('accessUser'), t('accessState'), '']}>
          {listing.access.map((row) => (
            <tr key={row.userId} data-testid="quant-access-row" data-user={row.userId} data-state={row.state}>
              <td lang="zxx">{row.userId}</td>
              <td>{t(`access_${row.state}`)}</td>
              <td>
                {row.state === 'granted' ? (
                  <Button variant="danger" onClick={() => void act('revoke', row.userId, row.rows)}>
                    {t('revoke', { user: row.userId })}
                  </Button>
                ) : (
                  <Button onClick={() => void act('grant', row.userId, row.rows)}>{t('grant', { user: row.userId })}</Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      )}
      <Field label={t('grantUser')} value={userId} onChange={(event) => setUserId(event.currentTarget.value)} />
      <Button
        onClick={() => {
          const user = userId.trim().toLowerCase();
          void act('grant', user, listing.access.find((row) => row.userId === user)?.rows ?? 0);
        }}
      >
        {t('grantNew')}
      </Button>
      {failure && <Failure result={failure} />}
    </section>
  );
}
