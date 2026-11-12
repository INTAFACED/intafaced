import { useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Badge, Button, EmptyState, KeyValue, PageSection, Table, Tabs, TabsList, TabsPanel, TabsTab } from '@intafaced/ui';
import type { TableColumn } from '@intafaced/ui';
import type { ApiClient } from '../../../shared/api';
import { displayAmount } from '../../../shared/money';
import { roomCopy } from './copy';
import type { Failure } from './guard';
import { useLive } from './live';
import { InfoNote, RefusalNote } from './parts';
import { roomRefusal } from './refusals';

/**
 * The lead's own desk (svc-trade `copy.lead.*`; J-copy-bots-otc-05 #1 #6 #7), at `/trade/copy?lead=1`: the lead's
 * copiers and removing them (one, or the ones ticked, each under its own key), the lead level with its threshold and
 * no profit-share ratio, and the listing with stopping leading. Every refusal is the room's own words.
 */

// hand-declared-ok: svc-trade's copy procedures have no browser-safe schema in packages/contracts yet (api.ts declares its own the same way)
const followersSchema = z.object({
  followers: z.array(
    z.object({
      followId: z.string(),
      state: z.string(),
      since: z.string(),
      investment: z.string().nullable(),
      asset: z.string().nullable(),
      openPositions: z.number(),
      removedAt: z.string().nullable(),
    }),
  ),
  removalDailyLimit: z.number().nullable(),
});
type Follower = z.infer<typeof followersSchema>['followers'][number];

const removalSchema = z.object({
  followId: z.string(),
  key: z.string(),
  outcome: z.enum(['removed', 'already_removed', 'refused']),
  code: z.string().optional(),
});
type Removal = z.infer<typeof removalSchema>;

const levelSchema = z.object({
  asset: z.string().nullable(),
  copiedFunds: z.string(),
  level: z.object({ name: z.string(), threshold: z.string() }).nullable(),
  next: z.object({ name: z.string(), threshold: z.string() }).nullable(),
  levelsSet: z.boolean(),
  maxRatio: z.null(),
});

const stopSchema = z.object({
  stopId: z.string(),
  key: z.string(),
  state: z.enum(['review_pending', 'approved', 'failed']),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  reason: z.string().nullable(),
});
const listingSchema = z.object({
  leaderRef: z.string(),
  displayName: z.string(),
  marketMode: z.string(),
  state: z.string(),
  stop: stopSchema.nullable(),
});

export function createLeadApi(api: ApiClient) {
  return {
    listing: (signal?: AbortSignal) => api.query('trade', 'copy.lead.listing', undefined, listingSchema, { signal }),
    followers: (signal?: AbortSignal) => api.query('trade', 'copy.lead.followers', undefined, followersSchema, { signal }),
    level: (signal?: AbortSignal) => api.query('trade', 'copy.lead.level', undefined, levelSchema, { signal }),
    remove: (followId: string) => api.mutate('trade', 'copy.lead.removeFollower', { followId }, removalSchema),
    removeMany: (followIds: string[]) =>
      api.mutate('trade', 'copy.lead.removeFollowers', { followIds }, z.object({ results: z.array(removalSchema) })),
    stop: (clientRequestId: string) => api.mutate('trade', 'copy.lead.stop', { clientRequestId }, stopSchema),
  };
}

type TabId = 'followers' | 'level' | 'listing';
const TABS: readonly TabId[] = ['followers', 'level', 'listing'];

const STATE_WORD: Record<string, string> = {
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  STOPPING: 'Stopping',
  CLOSE_ONLY: 'Closing only',
  DETACHED: 'Ended',
};
const STOP_WORD: Record<string, string> = {
  review_pending: 'Review pending',
  approved: 'Approved: you no longer lead',
  failed: 'Not approved: you still lead',
};
const LISTING_WORD: Record<string, string> = {
  listed: 'Listed',
  suspended: 'Suspended',
  delisted: 'Delisted',
  unlisted: 'Not listed',
};

/** A short public handle for a follow: copiers are named by their follow, never by who they are. */
const copierName = (followId: string) => `Copier ${followId.slice(0, 8)}`;

export function LeadDesk({ api, tab: requested, setTab }: { api: ApiClient; tab: string | null; setTab: (id: string) => void }) {
  const { t } = roomCopy.useCopy();
  const lead = useMemo(() => createLeadApi(api), [api]);
  const tab: TabId = TABS.find((id) => id === requested) ?? 'followers';
  const listing = useLive((signal) => lead.listing(signal), 'lead-listing', 30_000);
  const followers = useLive((signal) => lead.followers(signal), 'lead-followers', 15_000);
  const level = useLive((signal) => lead.level(signal), 'lead-level', 60_000);

  const [refusal, setRefusal] = useState<Failure | null>(null);
  const [results, setResults] = useState<Removal[]>([]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const sending = useRef(false);

  const once = async (id: string, run: () => Promise<void>) => {
    // One request at a time, and never a second while the first has no answer.
    if (sending.current) return;
    sending.current = true;
    setBusy(id);
    setRefusal(null);
    try {
      await run();
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const removeOne = (followId: string) =>
    once(followId, async () => {
      const out = await lead.remove(followId);
      if (out.ok) setResults([out.data]);
      else setRefusal(out);
      followers.reload();
      level.reload();
    });

  const removePicked = () =>
    once('bulk', async () => {
      const out = await lead.removeMany([...picked]);
      if (out.ok) {
        setResults(out.data.results);
        setPicked(new Set());
      } else setRefusal(out);
      followers.reload();
      level.reload();
    });

  // A stop request's key is made once per press and kept until it is answered, so a retry is the same request.
  const stopKey = useRef<string | null>(null);
  const stopLeading = () =>
    once('stop', async () => {
      stopKey.current ??= `lead-stop:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
      const out = await lead.stop(stopKey.current);
      if (out.ok || out.reason !== 'uncertain') stopKey.current = null;
      if (!out.ok) setRefusal(out);
      listing.reload();
    });

  const resultWord = (r: Removal) =>
    r.outcome === 'removed'
      ? t('{copier} removed', { copier: copierName(r.followId) })
      : r.outcome === 'already_removed'
        ? t('{copier} was already removed, skipped', { copier: copierName(r.followId) })
        : t('{copier} not removed: {reason}', {
            copier: copierName(r.followId),
            reason: r.code ? refusedTitle(r.code) : t('Refused'),
          });

  const columns: TableColumn<Follower>[] = [
    {
      id: 'pick',
      header: t('Pick'),
      width: 64,
      cell: (r) =>
        r.state === 'DETACHED' ? null : (
          <input
            type="checkbox"
            aria-label={t('Pick {copier}', { copier: copierName(r.followId) })}
            checked={picked.has(r.followId)}
            onChange={(e) => {
              const next = new Set(picked);
              if (e.target.checked) next.add(r.followId);
              else next.delete(r.followId);
              setPicked(next);
            }}
          />
        ),
    },
    { id: 'copier', header: t('Copier'), value: (r) => copierName(r.followId), pin: 'start', width: 170 },
    {
      id: 'state',
      header: t('State'),
      cell: (r) => (
        <Badge tone={r.state === 'ACTIVE' ? 'positive' : 'neutral'}>
          {r.removedAt ? t('Removed') : t((STATE_WORD[r.state] ?? r.state) as 'Active')}
        </Badge>
      ),
    },
    {
      id: 'investment',
      header: t('Set aside'),
      value: (r) => (r.investment && r.asset ? `${displayAmount(r.investment)} ${r.asset}` : t('None')),
    },
    { id: 'open', header: t('Open copied positions'), value: (r) => String(r.openPositions) },
    { id: 'since', header: t('Since'), value: (r) => new Date(r.since).toLocaleDateString() },
    {
      id: 'action',
      header: t('Action'),
      cell: (r) =>
        r.state === 'DETACHED' ? null : (
          <Button
            variant="secondary"
            size={28}
            loading={busy === r.followId}
            disabled={busy !== null}
            onClick={() => void removeOne(r.followId)}
          >
            {t('Remove')}
          </Button>
        ),
    },
  ];

  const limit = followers.data?.removalDailyLimit;
  const stop = listing.data?.stop ?? null;

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList divider aria-label={t('Lead desk sections')}>
        <TabsTab value="followers">{t('Followers')}</TabsTab>
        <TabsTab value="level">{t('Level')}</TabsTab>
        <TabsTab value="listing">{t('Listing')}</TabsTab>
      </TabsList>

      <TabsPanel value="followers">
        <PageSection
          title={t('Your copiers')}
          headingLevel={2}
          actions={
            <Button variant="secondary" size={28} disabled={picked.size === 0 || busy !== null} onClick={() => void removePicked()}>
              {t('Remove picked ({n})', { n: String(picked.size) })}
            </Button>
          }
        >
          {refusal ? <RefusalNote failure={refusal} /> : null}
          {results.length > 0 ? (
            <ul role="status" aria-label={t('Removal results')} className="cb-reasons">
              {results.map((r) => (
                <li key={r.key} data-key={r.key}>
                  {resultWord(r)}
                </li>
              ))}
            </ul>
          ) : null}
          <Table
            label={t('Your copiers')}
            columns={columns}
            rows={followers.data?.followers ?? []}
            getRowId={(r) => r.followId}
            status={followers.status === 'loading' ? 'loading' : followers.status === 'error' ? 'error' : 'ready'}
            refreshing={followers.refreshing && followers.data !== null}
            onRetry={followers.reload}
            minWidth={820}
            errorState={followers.failure ? <RefusalNote failure={followers.failure} retry={followers.reload} /> : undefined}
            emptyState={
              <EmptyState
                size="inline"
                title={t('No one copies you yet')}
                reason={t('When someone follows you, they appear here with what they set aside and their open copied positions.')}
              />
            }
          />
          <InfoNote>
            {limit != null
              ? t('You can remove up to {n} copiers a day. A copier with open copied positions can be removed once they are closed.', {
                  n: String(limit),
                })
              : t('Removing copiers is closed: the platform has not set the daily limit.')}
          </InfoNote>
        </PageSection>
      </TabsPanel>

      <TabsPanel value="level">
        <PageSection title={t('Your level')} headingLevel={2}>
          {level.failure ? <RefusalNote failure={level.failure} retry={level.reload} /> : null}
          <KeyValue
            items={[
              { label: t('Level'), value: level.data ? (level.data.level?.name ?? t('Not set')) : null },
              {
                label: t('Threshold'),
                value: level.data
                  ? level.data.level && level.data.asset
                    ? t('From {amount} {asset} of copied funds', {
                        amount: displayAmount(level.data.level.threshold),
                        asset: level.data.asset,
                      })
                    : t('Not set')
                  : null,
              },
              {
                label: t('Copied funds now'),
                value: level.data ? `${displayAmount(level.data.copiedFunds)} ${level.data.asset ?? ''}`.trim() : null,
              },
              {
                label: t('Next level'),
                value: level.data
                  ? level.data.next && level.data.asset
                    ? t('{name} from {amount} {asset}', {
                        name: level.data.next.name,
                        amount: displayAmount(level.data.next.threshold),
                        asset: level.data.asset,
                      })
                    : t('None')
                  : null,
              },
            ]}
          />
          <p>{t('Maximum ratio: not set by the platform')}</p>
          <InfoNote>
            {t('Leads are paid a share of the trading fee only. No profit share is taken, so no ratio can be set at any level.')}
          </InfoNote>
        </PageSection>
      </TabsPanel>

      <TabsPanel value="listing">
        <PageSection title={t('Your listing')} headingLevel={2}>
          {listing.failure ? <RefusalNote failure={listing.failure} retry={listing.reload} /> : null}
          {refusal ? <RefusalNote failure={refusal} /> : null}
          <KeyValue
            items={[
              { label: t('Name'), value: listing.data?.displayName ?? null },
              { label: t('Market'), value: listing.data?.marketMode ?? null },
              { label: t('Listing'), value: listing.data ? t((LISTING_WORD[listing.data.state] ?? listing.data.state) as 'Listed') : null },
              {
                label: t('Stop request'),
                value: listing.data ? (stop ? t((STOP_WORD[stop.state] ?? stop.state) as 'Review pending') : t('None')) : null,
              },
            ]}
          />
          {stop?.reason ? <p>{t('Founders’ reason: {reason}', { reason: stop.reason })}</p> : null}
          {listing.data?.state === 'listed' && stop?.state !== 'review_pending' ? (
            <Button variant="secondary" loading={busy === 'stop'} disabled={busy !== null} onClick={() => void stopLeading()}>
              {t('Stop leading')}
            </Button>
          ) : null}
          <InfoNote>
            {t('Close your open positions before you ask to stop. Founders then review the request; until they approve, you still lead.')}
          </InfoNote>
        </PageSection>
      </TabsPanel>
    </Tabs>
  );
}

/** The short title the room shows for a refused removal in a bulk result. */
const refusedTitle = (code: string): string => roomRefusal({ ok: false, reason: 'error', message: '', code }).title;
