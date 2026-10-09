/**
 * Support agent — project ops.support / identity contract shapes into desk tools.
 *
 * Spec: docs/ops/trk/agents.support.md Stage 2 + D26-P1-A2 done bar
 * ("KB + account-state grounded; no invent balance").
 *
 * Caller fixtures remain valid for tests. This module is the grounded path:
 * articles come from a published KB catalog (`SupportKbArticle`), and account
 * rows come from `SupportAccountGrounding` / `AccountState` — the same shapes
 * svc-support already reads. Empty catalog hits escalate; unread / plane-dark
 * account grounding refuses rather than inventing "your account is fine".
 * Money fields on a projected state refuse (`balance_field_forbidden`); they
 * are never stripped.
 */

import type { AccountState, SupportAccountGrounding, SupportKbArticle } from '@intafaced/contracts';
import { accountProjectionHasInventMoney, type AccountProjectionFixture, type KbArticleFixture, type TicketFixture } from './data-tools.js';

/** Map one published KB article into the agent fixture shape (keys only). */
export function kbArticleFromContract(article: SupportKbArticle): KbArticleFixture {
  return {
    articleKey: article.id,
    titleKey: article.titleKey,
    bodyKey: article.bodyKey,
  };
}

/**
 * Search a published catalog. Empty query → full catalog. Never invents a hit
 * for an unknown fragment (mirrors svc-support `searchKb`, kept local so the
 * agent does not SQL another service's tables).
 */
export function searchKbCatalog(query: string, catalog: readonly SupportKbArticle[]): readonly KbArticleFixture[] {
  const q = query.trim().toLowerCase();
  const hits = !q
    ? catalog
    : catalog.filter((a) => a.id.toLowerCase().includes(q) || a.titleKey.toLowerCase().includes(q) || a.bodyKey.toLowerCase().includes(q));
  return hits.map(kbArticleFromContract);
}

export type AccountFromStateRefuseReason =
  'account_plane_dark' | 'account_not_attempted' | 'account_owner_mismatch' | 'balance_field_forbidden' | 'incomplete_account';

export type AccountFromGroundingResult =
  | { readonly status: 'ok'; readonly account: AccountProjectionFixture }
  | { readonly status: 'refuse'; readonly reason: AccountFromStateRefuseReason };

/** Project a contract AccountState; refuse invent money / owner mismatch. */
export function accountFromState(state: AccountState, requesterUserId: string): AccountFromGroundingResult {
  if (accountProjectionHasInventMoney(state)) {
    return { status: 'refuse', reason: 'balance_field_forbidden' };
  }
  for (const key of Object.keys(state)) {
    if (key !== 'userId' && key !== 'status' && key !== 'kycTier') {
      return { status: 'refuse', reason: 'balance_field_forbidden' };
    }
  }
  if (!state.userId.trim() || !state.kycTier.trim()) {
    return { status: 'refuse', reason: 'incomplete_account' };
  }
  if (state.userId !== requesterUserId.trim()) {
    return { status: 'refuse', reason: 'account_owner_mismatch' };
  }
  return {
    status: 'ok',
    account: { userId: state.userId, status: state.status, kycTier: state.kycTier },
  };
}

/**
 * Project desk `SupportAccountGrounding`. `unread` is a fact — plane dark or
 * not attempted — never treated as a clean active account.
 */
export function accountFromGrounding(grounding: SupportAccountGrounding, requesterUserId: string): AccountFromGroundingResult {
  if (grounding.status === 'unread') {
    return {
      status: 'refuse',
      reason: grounding.reason === 'plane_dark' ? 'account_plane_dark' : 'account_not_attempted',
    };
  }
  return accountFromState(grounding.state, requesterUserId);
}

export type SupportAskGrounding = {
  readonly tool: string;
  /** Explicit articles win when non-empty; else `kbQuery` + catalog. */
  readonly articles?: readonly KbArticleFixture[] | null;
  /** Search fragment against the run's published catalog. */
  readonly kbQuery?: string | null;
  readonly ticket?: TicketFixture | null;
  readonly account?: AccountProjectionFixture | null;
  /** Contract grounding from ops.support / identity — preferred over raw account. */
  readonly accountGrounding?: SupportAccountGrounding | null;
};

export type ResolveAskFixturesOk = {
  readonly status: 'ok';
  readonly articles: readonly KbArticleFixture[] | null;
  readonly ticket: TicketFixture | null;
  readonly account: AccountProjectionFixture | null;
};

export type ResolveAskFixturesRefuse = {
  readonly status: 'refuse';
  readonly reason: AccountFromStateRefuseReason;
};

/**
 * Resolve one ask against optional published KB catalog + account grounding.
 * Does not invent: missing catalog+query → empty articles (tool escalates);
 * unread grounding → refuse with a named reason. A raw account with no
 * grounding is still projected through `accountFromState` — a different owner
 * or any key other than userId, status, and kycTier refuses, and is not stripped.
 */
export function resolveSupportAskFixtures(input: {
  ask: SupportAskGrounding;
  requesterUserId: string;
  kbCatalog?: readonly SupportKbArticle[] | null;
}): ResolveAskFixturesOk | ResolveAskFixturesRefuse {
  let articles: readonly KbArticleFixture[] | null = input.ask.articles ?? null;
  if ((!articles || articles.length === 0) && input.ask.kbQuery !== undefined && input.ask.kbQuery !== null) {
    const catalog = input.kbCatalog ?? [];
    articles = searchKbCatalog(input.ask.kbQuery, catalog);
  }

  let account: AccountProjectionFixture | null = null;
  if (input.ask.accountGrounding) {
    const resolved = accountFromGrounding(input.ask.accountGrounding, input.requesterUserId);
    if (resolved.status === 'refuse') {
      return { status: 'refuse', reason: resolved.reason };
    }
    account = resolved.account;
  } else if (input.ask.account) {
    const resolved = accountFromState(input.ask.account as AccountState, input.requesterUserId);
    if (resolved.status === 'refuse') {
      return { status: 'refuse', reason: resolved.reason };
    }
    account = resolved.account;
  }

  return {
    status: 'ok',
    articles,
    ticket: input.ask.ticket ?? null,
    account,
  };
}
