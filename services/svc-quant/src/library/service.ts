import {
  QUANT_LIBRARY_RESULT_LABEL,
  QUANT_LIBRARY_TAGS,
  QUANT_LISTING_VISIBILITIES,
  type QuantLibraryOptions,
  type QuantLibraryPage,
  type QuantLibraryTag,
  type QuantLineage,
  type QuantListing,
  type QuantListingCheck,
  type QuantListingCheckInput,
  type QuantListingPage,
  type QuantListingPreview,
  type QuantListingPublishInput,
  type QuantModerationAction,
  type QuantModerationEntry,
  type QuantModerationQueue,
} from '@intafaced/contracts';
import { z } from 'zod';
import {
  BACKTEST_HISTORY_PAGE_MAX,
  BAR_BACKTEST_KEY_PREFIX,
  isBarBacktest,
  readStoredBacktest,
  type StoredBacktest,
} from '../engine/run.js';
import {
  QUANT_LIBRARY_LICENCES_UNSET,
  QUANT_LISTING_ACCESS_DENIED,
  QUANT_LISTING_CHECK_FAILED,
  QUANT_LISTING_NOT_FOUND,
  QUANT_LISTING_SOURCE_PROTECTED,
  QUANT_LISTING_STALE,
  QUANT_REALISM_CHECKLIST_UNACCEPTED,
  QUANT_REALISM_CHECKLIST_UNSET,
  QUANT_DISPUTE_NOT_FOUND,
  QUANT_DISPUTE_TICKET_REQUIRED,
  QUANT_LIBRARY_QUEUE_LIMIT_UNSET,
  QUANT_MODERATION_REASON_REQUIRED,
  QUANT_MODERATION_STATE_INVALID,
  QUANT_REVIEW_NEEDS_RUN,
  QUANT_STUDIO_NOT_FOUND,
  QuantError,
} from '../errors.js';
import type { RunRepository } from '../runs/repository.js';
import { buildSavedStrategy } from '../studio/save.js';
import { draftOf, type StrategyDetail, type StrategyRepository } from '../studio/repository.js';
import { performanceClaims } from './claims.js';
import {
  accessState,
  moderationState,
  type LibraryRepository,
  type StoredDispute,
  type StoredListing,
  type StoredModeration,
} from './repository.js';

/** The owner's realism checklist: stored content with a version, never text written in code. */
export interface RealismChecklist {
  readonly version: string;
  readonly items: readonly string[];
}

/** `QUANT_REALISM_CHECKLIST` as JSON `{ "version": "...", "items": ["..."] }`; blank or unreadable is unset. */
export function parseRealismChecklist(raw: string | undefined): RealismChecklist | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = z
      .object({ version: z.string().trim().min(1), items: z.array(z.string().trim().min(1)).min(1) })
      .safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `QUANT_LIBRARY_LICENCES` as `|`-separated names; blank is unset. */
export function parseLicences(raw: string | undefined): string[] | null {
  const names = (raw ?? '')
    .split('|')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length ? names : null;
}

export interface LibraryDeps {
  readonly library: LibraryRepository;
  readonly strategies: StrategyRepository;
  readonly runs: RunRepository;
  readonly licences: readonly string[] | null;
  readonly checklist: RealismChecklist | null;
  /** The owner's queue page size (`library.queuePageSize`) as an operator stored it; null is not set. */
  readonly queuePageSize: () => Promise<string | null>;
  readonly now: () => number;
}

/** Which state each action needs: hide a listed one, unhide a hidden one, remove one that is listed or hidden. */
const MODERATION_FROM: Record<QuantModerationAction, readonly string[]> = {
  hide: ['listed'],
  unhide: ['hidden'],
  remove: ['listed', 'hidden'],
};

const disputeView = (row: StoredDispute) => ({
  disputeId: row.id,
  listingId: row.listingId,
  openedBy: row.openedBy,
  reason: row.reason,
  ticketRef: row.ticketRef,
  openedAt: row.openedAt,
  state: row.resolution ? ('resolved' as const) : ('open' as const),
  resolution: row.resolution ? { ...row.resolution } : null,
});

const listingKey = (strategyId: string, version: number) => `quant.listing:${strategyId}:v${version}`;
const cloneKey = (listingId: string) => `quant.library.clone:${listingId}`;
const newestOf = (strategy: StrategyDetail) => Math.max(...strategy.versions.map((row) => row.version));

/** The strategy library (J-algo-dev-09): publish checks, listings, invite-only access, clones and reviews. */
export function createLibrary(deps: LibraryDeps) {
  const { library, strategies, runs } = deps;
  const at = () => new Date(deps.now());

  function requireLicences(): readonly string[] {
    if (!deps.licences?.length) {
      throw new QuantError(QUANT_LIBRARY_LICENCES_UNSET, 'licence list — the owner has not published the licences a listing may carry');
    }
    return deps.licences;
  }
  function requireChecklist(): RealismChecklist {
    if (!deps.checklist) throw new QuantError(QUANT_REALISM_CHECKLIST_UNSET, 'realism checklist — the owner has not published it');
    return deps.checklist;
  }
  function notFound(): never {
    throw new QuantError(QUANT_LISTING_NOT_FOUND, 'listing not found');
  }
  async function listingOrFail(listingId: string): Promise<StoredListing> {
    return (await library.listing(listingId)) ?? notFound();
  }
  /** A listing the caller may reach: a hidden or removed one reads as not found to everyone but its owner. */
  async function reachable(listingId: string, accountId: string): Promise<StoredListing> {
    const listing = await listingOrFail(listingId);
    if (listing.ownerId !== accountId && moderationState(await library.moderation(listing.id)) !== 'listed') notFound();
    return listing;
  }
  function requireReason(raw: string, what: string): string {
    const reason = raw.trim();
    if (!reason) throw new QuantError(QUANT_MODERATION_REASON_REQUIRED, `reason — ${what} needs a reason; nothing changed`);
    return reason;
  }
  function entryOf(
    listing: StoredListing,
    head: StrategyDetail | null,
    audit: readonly StoredModeration[],
    disputes: readonly StoredDispute[],
  ): QuantModerationEntry {
    return {
      listingId: listing.id,
      title: listing.title,
      description: listing.description,
      tags: [...listing.tags],
      visibility: listing.visibility,
      licence: listing.licence,
      ownerId: listing.ownerId,
      strategyId: listing.strategyId,
      strategyVersion: listing.strategyVersion,
      listedAt: listing.listedAt,
      facts: { runId: listing.runId, checklistVersion: listing.checklistVersion, stale: staleAgainst(listing, head) },
      state: moderationState(audit),
      audit: audit.map((row) => ({ seq: row.seq, action: row.action, actor: row.actor, reason: row.reason, at: row.at })),
      disputes: disputes.map(disputeView),
    };
  }
  async function entry(listing: StoredListing): Promise<QuantModerationEntry> {
    return entryOf(listing, await headOf(listing), await library.moderation(listing.id), await library.disputes([listing.id]));
  }

  /** The newest finished bar backtest of exactly this version of the account's strategy. */
  async function backtestOf(
    accountId: string,
    strategyId: string,
    version: number,
  ): Promise<{ runId: string; stored: StoredBacktest } | null> {
    const page = await runs.history({
      userId: accountId,
      kind: 'backtest',
      keyPrefix: BAR_BACKTEST_KEY_PREFIX,
      limit: BACKTEST_HISTORY_PAGE_MAX,
      cursor: null,
      strategyId,
    });
    for (const row of page.runs) {
      if (row.strategyVersion !== version || !row.finished || row.outcome !== 'ok') continue;
      const full = await runs.get({ userId: accountId, id: row.id });
      const stored = full && isBarBacktest(full) ? readStoredBacktest(full.response) : null;
      if (stored) return { runId: full!.id, stored };
    }
    return null;
  }

  /** Whether the account has any finished run of one of its strategies: a backtest, or a paper run that stopped. */
  async function hasRun(accountId: string, strategyId: string): Promise<boolean> {
    const page = await runs.history({
      userId: accountId,
      kind: 'backtest',
      keyPrefix: BAR_BACKTEST_KEY_PREFIX,
      limit: BACKTEST_HISTORY_PAGE_MAX,
      cursor: null,
      strategyId,
    });
    if (page.runs.some((row) => row.finished && row.outcome === 'ok')) return true;
    const paper = await runs.paperRuns({ userId: accountId, strategyId, limit: 50 });
    return paper.some((row) => row.run.finished);
  }

  async function headOf(listing: StoredListing): Promise<StrategyDetail | null> {
    const found = await strategies.get({ accountId: listing.ownerId, id: listing.strategyId });
    return found && !found.deletedAt ? found : null;
  }
  const staleAgainst = (listing: StoredListing, head: StrategyDetail | null) => !head || newestOf(head) > listing.strategyVersion;

  async function listingView(listing: StoredListing): Promise<QuantListing> {
    const head = await headOf(listing);
    const rows = await library.access(listing.id);
    return {
      listingId: listing.id,
      strategyId: listing.strategyId,
      strategyVersion: listing.strategyVersion,
      headVersion: head ? newestOf(head) : null,
      stale: staleAgainst(listing, head),
      title: listing.title,
      description: listing.description,
      tags: [...listing.tags],
      visibility: listing.visibility,
      licence: listing.licence,
      checklistVersion: listing.checklistVersion,
      listedAt: listing.listedAt,
      access: accessState(rows).map(({ row, count }) => ({
        userId: row.userId,
        state: row.action === 'request' ? 'requested' : row.action === 'grant' ? 'granted' : 'revoked',
        at: row.at,
        rows: count,
      })),
    };
  }

  /** The caller's access to a listing, and how many access rows they have on it. */
  async function accessOf(listing: StoredListing, accountId: string): Promise<{ access: QuantListingPreview['access']; rows: number }> {
    if (listing.ownerId === accountId) return { access: 'owner', rows: 0 };
    const mine = (await library.access(listing.id)).filter((row) => row.userId === accountId);
    if (listing.visibility !== 'invite') return { access: 'open', rows: mine.length };
    const newest = mine.at(-1);
    const access = !newest ? 'none' : newest.action === 'grant' ? 'granted' : newest.action === 'request' ? 'requested' : 'revoked';
    return { access, rows: mine.length };
  }
  async function readable(listing: StoredListing, accountId: string): Promise<void> {
    const { access } = await accessOf(listing, accountId);
    if (access === 'owner' || access === 'open' || access === 'granted') return;
    throw new QuantError(QUANT_LISTING_ACCESS_DENIED, 'this listing is invite-only and you hold no grant from its owner');
  }

  async function check(accountId: string, input: QuantListingCheckInput): Promise<QuantListingCheck & { runId: string | null }> {
    const licences = requireLicences();
    const title = input.title.trim();
    const description = input.description.trim();
    if (!title) throw new QuantError('quant.params_invalid', 'title — a listing needs a title');
    if (!description) throw new QuantError('quant.params_invalid', 'description — a listing needs a description');
    const found = await strategies.get({ accountId, id: input.strategyId });
    if (!found || found.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
    const version = input.strategyVersion;
    const exists = found.versions.some((row) => row.version === version);
    const newest = newestOf(found);
    const backtest = exists ? await backtestOf(accountId, found.id, version) : null;
    const costs = backtest?.stored.costs;
    const claims = performanceClaims(`${title}\n${description}`);
    const checks: QuantListingCheck['checks'] = [
      {
        id: 'version',
        passed: exists && version === newest,
        detail: !exists
          ? `version ${version} does not exist`
          : version === newest
            ? `version ${version} is the newest version`
            : `version ${version} is not the newest; check version ${newest}`,
      },
      {
        id: 'backtest',
        passed: backtest !== null,
        detail: backtest ? `backtest ${backtest.runId} of version ${version} finished` : `no finished backtest of version ${version}`,
      },
      {
        id: 'costs',
        passed: Boolean(costs?.feeScheduleVersion),
        detail: costs?.feeScheduleVersion
          ? `fees ${costs.feeScheduleVersion} (${costs.feeRole}, ${costs.feeBps} bps), slippage ${costs.slippageBps} bps, delay ${costs.delayBars} bars`
          : `no backtest of version ${version} with its costs set`,
      },
      {
        id: 'claim',
        passed: claims.length === 0,
        detail: claims.length === 0 ? 'no performance claim' : `performance claim: "${claims[0]}"`,
      },
      {
        id: 'licence',
        passed: licences.includes(input.licence),
        detail: licences.includes(input.licence) ? `licence ${input.licence}` : 'pick a licence from the published list',
      },
    ];
    return {
      strategyId: found.id,
      strategyVersion: version,
      passed: checks.every((row) => row.passed),
      checks,
      runId: backtest?.runId ?? null,
    };
  }

  return {
    options(): QuantLibraryOptions {
      return {
        licences: deps.licences?.length ? [...deps.licences] : null,
        checklist: deps.checklist ? { version: deps.checklist.version, items: [...deps.checklist.items] } : null,
        tags: [...QUANT_LIBRARY_TAGS],
        visibilities: [...QUANT_LISTING_VISIBILITIES],
      };
    },

    async check(accountId: string, input: QuantListingCheckInput): Promise<QuantListingCheck> {
      const { runId: _runId, ...reading } = await check(accountId, input);
      return reading;
    },

    /**
     * Lists one version under `quant.listing:<strategy>:v<version>`. A version that is no longer the newest refuses
     * `quant.listing_stale`; then every check runs again on the server and the first failing one refuses by name; then
     * the checklist must be accepted at its current version. The same publish twice returns the one listing.
     */
    async publish(accountId: string, input: QuantListingPublishInput): Promise<QuantListing> {
      const found = await strategies.get({ accountId, id: input.strategyId });
      if (!found || found.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      const newest = newestOf(found);
      if (input.strategyVersion < newest && found.versions.some((row) => row.version === input.strategyVersion)) {
        throw new QuantError(
          QUANT_LISTING_STALE,
          `version ${input.strategyVersion} is not the newest (version ${newest}); run the checks for version ${newest} before it is listed`,
        );
      }
      const reading = await check(accountId, input);
      const failed = reading.checks.find((row) => !row.passed);
      if (failed) throw new QuantError(QUANT_LISTING_CHECK_FAILED, `${failed.id} — ${failed.detail}; nothing was listed`);
      const checklist = requireChecklist();
      if (!input.checklistAccepted || input.checklistVersion !== checklist.version) {
        throw new QuantError(
          QUANT_REALISM_CHECKLIST_UNACCEPTED,
          `realism checklist — accept every item of checklist ${checklist.version} before publishing; nothing was listed`,
        );
      }
      const listing = await library.publish({
        key: listingKey(found.id, input.strategyVersion),
        ownerId: accountId,
        strategyId: found.id,
        strategyVersion: input.strategyVersion,
        runId: reading.runId!,
        title: input.title.trim(),
        description: input.description.trim(),
        tags: [...new Set(input.tags)],
        visibility: input.visibility,
        licence: input.licence,
        checklistVersion: checklist.version,
        at: at(),
      });
      return listingView(listing);
    },

    async mine(accountId: string): Promise<QuantListing[]> {
      return Promise.all((await library.listingsOf(accountId)).map(listingView));
    },

    /** Open and protected listings that are not stale, in registration order; never by return. */
    async browse(input: { tag: QuantLibraryTag | null; limit: number; cursor: string | null }): Promise<QuantLibraryPage> {
      let after = 0;
      if (input.cursor) {
        after = Number(input.cursor);
        if (!Number.isInteger(after) || after < 0) throw new QuantError('quant.list_cursor_invalid', 'cursor is not one this list gave');
      }
      const entries: QuantLibraryPage['entries'] = [];
      let more = true;
      while (entries.length < input.limit && more) {
        const rows = await library.browse({ tag: input.tag, afterSeq: after, limit: input.limit });
        more = rows.length === input.limit;
        const moderated = await library.moderationOf(rows.map((row) => row.id));
        for (const row of rows) {
          after = row.seq;
          if (staleAgainst(row, await headOf(row)) || row.visibility === 'invite') continue;
          if (moderationState(moderated.filter((m) => m.listingId === row.id)) !== 'listed') continue;
          entries.push({
            listingId: row.id,
            title: row.title,
            tags: [...row.tags],
            visibility: row.visibility,
            licence: row.licence,
            strategyVersion: row.strategyVersion,
            ownerId: row.ownerId,
            listedAt: row.listedAt,
          });
          if (entries.length === input.limit) break;
        }
      }
      return { entries, nextCursor: entries.length === input.limit ? String(after) : null };
    },

    async preview(accountId: string, listingId: string): Promise<QuantListingPreview> {
      const listing = await reachable(listingId, accountId);
      const { access, rows } = await accessOf(listing, accountId);
      return { listingId: listing.id, title: listing.title, visibility: listing.visibility, access, rows };
    },

    /** The strategy page. An invite-only listing without a grant refuses; a protected listing never returns its source. */
    async get(accountId: string, listingId: string): Promise<QuantListingPage> {
      const listing = await reachable(listingId, accountId);
      await readable(listing, accountId);
      const mine = listing.ownerId === accountId;
      const versions = await strategies.versions({ accountId: listing.ownerId, id: listing.strategyId });
      const version = versions?.find((row) => row.version === listing.strategyVersion);
      const run = await runs.get({ userId: listing.ownerId, id: listing.runId });
      const stored = run && isBarBacktest(run) ? readStoredBacktest(run.response) : null;
      const clone = await library.cloneOf({ listingId: listing.id, accountId });
      return {
        listingId: listing.id,
        title: listing.title,
        description: listing.description,
        tags: [...listing.tags],
        visibility: listing.visibility,
        licence: listing.licence,
        strategyVersion: listing.strategyVersion,
        stale: staleAgainst(listing, await headOf(listing)),
        ownerId: listing.ownerId,
        listedAt: listing.listedAt,
        mine,
        source: listing.visibility === 'protected' && !mine ? null : (version?.source ?? null),
        result: stored
          ? {
              runId: listing.runId,
              label: QUANT_LIBRARY_RESULT_LABEL,
              symbol: stored.symbol,
              from: stored.window.from,
              to: stored.window.to,
              startCash: stored.totals.startCash,
              net: stored.totals.net,
              endEquity: stored.totals.endEquity,
              trades: stored.trades.length,
            }
          : null,
        reviews: (await library.reviews(listing.id)).map((row) => ({
          reviewerId: row.reviewerId,
          text: row.text,
          createdAt: row.createdAt,
        })),
        clone: clone ? { strategyId: clone.strategyId } : null,
      };
    },

    /** Asks the owner of an invite-only listing for access, under `<listing>:<caller>:request:<seq>`. */
    async request(accountId: string, input: { listingId: string; seq: number }): Promise<QuantListingPreview> {
      const listing = await reachable(input.listingId, accountId);
      if (listing.visibility !== 'invite' || listing.ownerId === accountId) {
        throw new QuantError('quant.params_invalid', 'only an invite-only listing of another person takes an access request');
      }
      await library.addAccess({ listingId: listing.id, userId: accountId, action: 'request', seq: input.seq, actor: accountId, at: at() });
      return this.preview(accountId, listing.id);
    },

    /** The owner grants or revokes one person's access, under `<listing>:<person>:<action>:<seq>`. */
    async setAccess(
      accountId: string,
      input: { listingId: string; userId: string; seq: number },
      action: 'grant' | 'revoke',
    ): Promise<QuantListing> {
      const listing = await listingOrFail(input.listingId);
      if (listing.ownerId !== accountId) notFound();
      const userId = input.userId.trim().toLowerCase();
      if (!z.string().guid().safeParse(userId).success || userId === accountId.toLowerCase()) {
        throw new QuantError('quant.params_invalid', 'userId — not another account id');
      }
      if (listing.visibility !== 'invite') throw new QuantError('quant.params_invalid', 'only an invite-only listing has access grants');
      await library.addAccess({ listingId: listing.id, userId, action, seq: input.seq, actor: accountId, at: at() });
      return listingView(listing);
    },

    /**
     * Copies the listed version into the caller's library as a new strategy at version 1, its lineage kept. A protected
     * listing refuses `quant.listing_source_protected`; an invite-only one needs a grant. One clone per person per listing.
     */
    async clone(accountId: string, listingId: string): Promise<QuantLineage> {
      const listing = await reachable(listingId, accountId);
      await readable(listing, accountId);
      if (listing.visibility === 'protected' && listing.ownerId !== accountId) {
        throw new QuantError(QUANT_LISTING_SOURCE_PROTECTED, 'this listing is protected: its source is never copied');
      }
      const prior = await strategies.replay(accountId, cloneKey(listing.id));
      let strategyId: string;
      if (prior?.operation === 'create') strategyId = prior.response.id;
      else {
        const versions = await strategies.versions({ accountId: listing.ownerId, id: listing.strategyId });
        const version = versions?.find((row) => row.version === listing.strategyVersion);
        if (!version) notFound();
        const built = buildSavedStrategy(
          {
            name: `${version.name} copy`.slice(0, 128),
            blocks: version.blocks,
            modules: version.modules,
            risk: version.risk,
            cash: version.cash,
            environment: version.environment,
            presentedAs: version.environment,
          },
          'studio_pending',
        );
        const created = await strategies.create({
          accountId,
          clientStrategyId: `library:${listing.id}`,
          idempotencyKey: cloneKey(listing.id),
          draft: draftOf(built),
        });
        strategyId = created.id;
      }
      const row = await library.recordClone({
        strategyId,
        accountId,
        listingId: listing.id,
        sourceVersion: listing.strategyVersion,
        at: at(),
      });
      return {
        strategyId: row.strategyId,
        listingId: listing.id,
        listingTitle: listing.title,
        sourceVersion: row.sourceVersion,
        clonedAt: row.clonedAt,
      };
    },

    /** Where one of the caller's strategies came from; null for one they wrote. */
    async lineage(accountId: string, strategyId: string): Promise<QuantLineage | null> {
      const found = await strategies.get({ accountId, id: strategyId });
      if (!found) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      const row = await library.lineage(found.id);
      if (!row || row.accountId !== accountId) return null;
      const listing = await library.listing(row.listingId);
      return {
        strategyId: row.strategyId,
        listingId: row.listingId,
        listingTitle: listing?.title ?? '',
        sourceVersion: row.sourceVersion,
        clonedAt: row.clonedAt,
      };
    },

    /** A review, once per person, only after their own clone of the listing has a finished run. */
    async review(accountId: string, input: { listingId: string; text: string }): Promise<QuantListingPage> {
      const listing = await reachable(input.listingId, accountId);
      await readable(listing, accountId);
      const text = input.text.trim();
      if (!text) throw new QuantError('quant.params_invalid', 'text — a review needs text');
      const clone = await library.cloneOf({ listingId: listing.id, accountId });
      if (!clone || !(await hasRun(accountId, clone.strategyId))) {
        throw new QuantError(
          QUANT_REVIEW_NEEDS_RUN,
          'a review needs a finished run of your own clone of this strategy first; nothing was saved',
        );
      }
      const claims = performanceClaims(text);
      if (claims.length) {
        throw new QuantError(QUANT_LISTING_CHECK_FAILED, `claim — performance claim: "${claims[0]}"; nothing was saved`);
      }
      await library.addReview({ listingId: listing.id, reviewerId: accountId, text, at: at() });
      return this.get(accountId, listing.id);
    },

    /**
     * The review queue (AL-library-03): every listing oldest first, with the facts its publish check relied on, its state,
     * its audit rows and its disputes, never its source. The owner's page size (`library.queuePageSize`) blank refuses.
     */
    async queue(input: { cursor: string | null }): Promise<QuantModerationQueue> {
      const raw = (await deps.queuePageSize())?.trim() ?? '';
      const pageSize = Number(raw);
      if (!raw || !Number.isInteger(pageSize) || pageSize < 1) {
        throw new QuantError(QUANT_LIBRARY_QUEUE_LIMIT_UNSET, 'library.queuePageSize — the owner has not set the review queue page size');
      }
      let after = 0;
      if (input.cursor) {
        after = Number(input.cursor);
        if (!Number.isInteger(after) || after < 0) throw new QuantError('quant.list_cursor_invalid', 'cursor is not one this list gave');
      }
      const rows = await library.queue({ afterSeq: after, limit: pageSize });
      const ids = rows.map((row) => row.id);
      const [audit, disputes] = await Promise.all([library.moderationOf(ids), library.disputes(ids)]);
      const entries = await Promise.all(
        rows.map(async (row) =>
          entryOf(
            row,
            await headOf(row),
            audit.filter((m) => m.listingId === row.id),
            disputes.filter((d) => d.listingId === row.id),
          ),
        ),
      );
      return { pageSize, entries, nextCursor: rows.length === pageSize ? String(rows.at(-1)!.seq) : null };
    },

    /**
     * Hides, unhides or removes one listing, as one audit row under `quant.moderation:<listing>:<seq>` naming the actor
     * and the reason. A blank reason refuses and writes nothing; so does an action the listing's state does not take. The
     * same (listing, seq) again returns the first row: a lost reply is safe to repeat.
     */
    async moderate(
      actor: string,
      input: { listingId: string; reason: string; seq: number },
      action: QuantModerationAction,
    ): Promise<QuantModerationEntry> {
      const listing = await listingOrFail(input.listingId);
      const reason = requireReason(input.reason, `${action} of a listing`);
      const rows = await library.moderation(listing.id);
      const prior = rows.find((row) => row.seq === input.seq);
      if (!prior) {
        const state = moderationState(rows);
        if (!MODERATION_FROM[action].includes(state)) {
          throw new QuantError(QUANT_MODERATION_STATE_INVALID, `${action} — this listing is ${state}; nothing changed`);
        }
        if (input.seq !== rows.length) {
          throw new QuantError('quant.params_invalid', `seq — this listing has ${rows.length} audit rows; read it again`);
        }
        await library.moderate({ listingId: listing.id, seq: input.seq, action, actor, reason, at: at() });
      }
      return entry(listing);
    },

    /** Opens a dispute on a listing with its support ticket reference, under (listing, seq). */
    async openDispute(
      actor: string,
      input: { listingId: string; reason: string; ticketRef: string; seq: number },
    ): Promise<QuantModerationEntry> {
      const listing = await listingOrFail(input.listingId);
      const reason = requireReason(input.reason, 'a dispute');
      const ticketRef = input.ticketRef.trim();
      if (!ticketRef) {
        throw new QuantError(QUANT_DISPUTE_TICKET_REQUIRED, 'ticketRef — a dispute needs its support ticket reference; nothing changed');
      }
      await library.openDispute({ listingId: listing.id, seq: input.seq, openedBy: actor, reason, ticketRef, at: at() });
      return entry(listing);
    },

    /** Resolves an open dispute with a reason; a second resolution returns the first. */
    async resolveDispute(actor: string, input: { disputeId: string; reason: string }): Promise<QuantModerationEntry> {
      const found = await library.dispute(input.disputeId);
      if (!found) throw new QuantError(QUANT_DISPUTE_NOT_FOUND, 'dispute not found');
      const reason = requireReason(input.reason, 'resolving a dispute');
      await library.resolveDispute({ id: found.id, actor, reason, at: at() });
      return entry(await listingOrFail(found.listingId));
    },
  };
}
