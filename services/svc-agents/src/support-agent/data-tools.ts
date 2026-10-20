/**
 * Support agent Stage-2 — real desk data tools with typed refusals.
 *
 * Spec: docs/ops/trk/agents.support.md Stage 2 ("KB tool after ops.support
 * Stage 1+", "read-only account projection tool", "typed I-don't-know /
 * escalate path").
 *
 * Three properties this file exists to hold:
 *
 * **Nothing is invented.** Live reads go through `SupportDeskPort` (HTTP/tRPC to
 * svc-support KB + ticket get, identity account projection). A live plane with
 * no port refuses `no_live_kb`. Fixture rows stay test-only via
 * `createFixtureSupportDesk`. A dark desk, empty KB, missing row or blank field
 * refuses with a reason. The support agent never answers "your account is fine"
 * from a gap in its inputs.
 *
 * **The account projection carries no money.** Doctrine §0.6 — balances live in
 * `packages/ledger-client` and nowhere else, and the tracker's PII line says to
 * minimise what reaches the model. So the projection is status + KYC tier and
 * literally nothing else: there is no balance field to leak, invent, or drift.
 *
 * **A support agent reads the asking user's own desk, not someone else's.** Every
 * row-scoped tool takes the requester's id and refuses when the row belongs to
 * another user. Without this door the assist layer is a PII read of any ticket id
 * a model can guess. Operator-assist (reading a ticket you were assigned) is a
 * real product, but it is residual product law — refuse-closed until published,
 * never inferred here.
 *
 * Money tools stay undeclared in the Stage-1 guardrail and are refused before
 * dispatch; this file refuses them again by name so the denial is visible in the
 * audit trail rather than only in the guardrail's silence.
 */

import { assertKbSearchPageLimit, AgentError } from '../errors.js';
import type { SupportDeskPort } from './desk-port.js';
import { isSupportMoneyTool, supportAgentGuardrail } from './guardrail.js';
import { supportGrounded, type SupportDeskPlane, type SupportKbPlane } from './grounded.js';
import { supportTierGate, type SupportTierLaw, type SupportTierGateRefuse } from './tier-gate.js';

export const SUPPORT_DATA_TOOLS = ['support.kb.search', 'support.ticket.read', 'identity.account.read'] as const;
export type SupportDataToolName = (typeof SUPPORT_DATA_TOOLS)[number];

/**
 * A KB article as the desk stores it: i18n keys, never rendered prose (§0.7 —
 * user copy is keyed so no vendor name can be pasted into an answer).
 */
export type KbArticleFixture = {
  readonly articleKey: string;
  readonly titleKey: string;
  readonly bodyKey: string;
};

export type TicketFixture = {
  readonly ticketId: string;
  readonly ownerUserId: string;
  readonly status: 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
  readonly category: string;
};

/**
 * Read-only identity projection. Status and KYC tier only — no balances, by
 * construction rather than by discipline (Doctrine §0.6).
 */
export type AccountProjectionFixture = {
  readonly userId: string;
  readonly status: 'active' | 'frozen' | 'closed';
  readonly kycTier: string;
};

export type SupportDataToolOk =
  | {
      readonly status: 'ok';
      readonly tool: 'support.kb.search';
      readonly articles: readonly KbArticleFixture[];
    }
  | {
      readonly status: 'ok';
      readonly tool: 'support.ticket.read';
      readonly ticket: TicketFixture;
    }
  | {
      readonly status: 'ok';
      readonly tool: 'identity.account.read';
      readonly account: AccountProjectionFixture;
    };

export type SupportDataToolRefuseReason =
  | 'desk_plane_dark'
  | 'no_live_kb'
  | 'kb_empty'
  | 'tier_law_blank'
  | 'tier_not_granted'
  | 'tool_not_declared'
  | 'money_tool'
  | 'tool_not_in_tier'
  | 'missing_requester'
  | 'missing_fixture'
  | 'empty_results'
  | 'incomplete_article'
  | 'incomplete_ticket'
  | 'incomplete_account'
  | 'not_ticket_owner'
  | 'account_owner_mismatch'
  /** Runtime payload carried a money field — refuse invent, do not strip-and-lie. */
  | 'balance_field_forbidden'
  /** ops.support / identity grounding said plane dark — do not invent account state. */
  | 'account_plane_dark'
  /** Grounding was never attempted — not the same as a clean active account. */
  | 'account_not_attempted'
  /** Owner-published KB search page size missing — never invent 100. */
  | 'kb_search_limit_unset';

/**
 * Money-shaped keys that must never appear on an account projection fixture.
 * Checked at runtime because JSON / spreads can smuggle fields TypeScript drops.
 * A stem matches at the start when the next character is `_` or the end
 * (`balance`, `available_balance`).
 */
const ACCOUNT_MONEY_KEY = /^(balance|available|amount|hold|credit|debit|equity|pnl|funds|wallet|reserved)(_|$)/i;

/** Same stems, for a camelCase boundary check that must stay case-sensitive. */
const ACCOUNT_MONEY_STEM = /^(balance|available|amount|hold|credit|debit|equity|pnl|funds|wallet|reserved)/i;

/**
 * A money stem as a later camel hump (`unrealizedPnl`). The `i` flag is absent
 * so `[A-Z]` does not also match a lowercase letter.
 */
const ACCOUNT_MONEY_CAMEL_HUMP = /(?<=[a-z])(?:Balance|Available|Amount|Hold|Credit|Debit|Equity|Pnl|Funds|Wallet|Reserved)(?=[A-Z]|$)/;

function keyIsInventMoney(key: string): boolean {
  if (ACCOUNT_MONEY_KEY.test(key) || ACCOUNT_MONEY_CAMEL_HUMP.test(key) || /balance|amount/i.test(key)) return true;
  // `creditLimit` starts with a stem, then a letter. The snake regex only
  // accepts `_` or end, so the next character is checked on its own.
  const stem = ACCOUNT_MONEY_STEM.exec(key);
  if (!stem) return false;
  const next = key.charAt(stem[0].length);
  return next >= 'A' && next <= 'Z';
}

/** True when a projection object invents money fields beyond status + KYC. */
export function accountProjectionHasInventMoney(account: object): boolean {
  for (const key of Object.keys(account)) {
    if (keyIsInventMoney(key)) return true;
  }
  return false;
}

export type SupportDataToolRefuse = {
  readonly status: 'refuse';
  readonly tool: string;
  readonly reason: SupportDataToolRefuseReason;
  readonly userMessageKey: 'agents.support.unavailable' | 'agents.support.tier_closed' | 'agents.refused.kb_search_limit_unset';
};

export type SupportDataToolResult = SupportDataToolOk | SupportDataToolRefuse;

function unavailable(tool: string, reason: SupportDataToolRefuseReason): SupportDataToolRefuse {
  return { status: 'refuse', tool, reason, userMessageKey: 'agents.support.unavailable' };
}

function isDeclaredDataTool(tool: string): tool is SupportDataToolName {
  return (SUPPORT_DATA_TOOLS as readonly string[]).includes(tool);
}

function tierRefuseToData(tool: string, refuse: SupportTierGateRefuse): SupportDataToolRefuse {
  return { status: 'refuse', tool, reason: refuse.reason, userMessageKey: refuse.userMessageKey };
}

/** An i18n key, not a sentence someone typed. */
function isKeyLike(value: string): boolean {
  return /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/i.test(value.trim());
}

function articlesOrRefuse(
  tool: string,
  articles: readonly KbArticleFixture[],
  emptyReason: SupportDataToolRefuseReason,
): SupportDataToolResult {
  if (articles.length === 0) {
    return unavailable(tool, emptyReason);
  }
  for (const a of articles) {
    if (!isKeyLike(a.articleKey) || !isKeyLike(a.titleKey) || !isKeyLike(a.bodyKey)) {
      return unavailable(tool, 'incomplete_article');
    }
  }
  return {
    status: 'ok',
    tool: 'support.kb.search',
    articles: articles.map((a) => ({ articleKey: a.articleKey, titleKey: a.titleKey, bodyKey: a.bodyKey })),
  };
}

async function invokeViaDesk(
  tool: SupportDataToolName,
  requester: string,
  desk: SupportDeskPort,
  input: {
    kbQuery?: string | null;
    kbSearchLimit?: number;
    ticket?: TicketFixture | null;
    deskHeaders?: Readonly<Record<string, string>>;
  },
): Promise<SupportDataToolResult> {
  if (tool === 'support.kb.search') {
    let page: number;
    try {
      page = assertKbSearchPageLimit(input.kbSearchLimit);
    } catch (err) {
      if (err instanceof AgentError && err.code === 'agents.kb_search_limit_unset') {
        return {
          status: 'refuse',
          tool,
          reason: 'kb_search_limit_unset',
          userMessageKey: 'agents.refused.kb_search_limit_unset',
        };
      }
      throw err;
    }
    const found = await desk.searchKb(input.kbQuery ?? '', page);
    if (found.status === 'refuse') {
      return { status: 'refuse', tool, reason: found.reason, userMessageKey: found.userMessageKey };
    }
    if (found.status === 'unreachable') return unavailable(tool, 'no_live_kb');
    return articlesOrRefuse(tool, found.articles, 'kb_empty');
  }

  if (tool === 'support.ticket.read') {
    const ticketId = input.ticket?.ticketId?.trim() ?? '';
    if (!ticketId) return unavailable(tool, 'missing_fixture');
    const read = await desk.readTicket(ticketId, input.deskHeaders);
    if (read.status === 'unreachable') return unavailable(tool, 'no_live_kb');
    if (read.status === 'missing') return unavailable(tool, 'missing_fixture');
    const ticket = read.ticket;
    const portTicketId = ticket.ticketId.trim();
    if (!portTicketId) {
      return unavailable(tool, 'incomplete_ticket');
    }
    if (portTicketId !== ticketId) {
      return unavailable(tool, 'missing_fixture');
    }
    if (!ticket.category.trim() || !ticket.ownerUserId.trim()) {
      return unavailable(tool, 'incomplete_ticket');
    }
    if (ticket.ownerUserId !== requester) {
      return unavailable(tool, 'not_ticket_owner');
    }
    return {
      status: 'ok',
      tool: 'support.ticket.read',
      ticket: {
        ticketId: ticket.ticketId,
        ownerUserId: ticket.ownerUserId,
        status: ticket.status,
        category: ticket.category,
      },
    };
  }

  const read = await desk.readAccount(requester);
  if (read.status === 'unreachable') return unavailable(tool, 'no_live_kb');
  if (read.status === 'unread') return unavailable(tool, 'account_plane_dark');
  const account = read.account;
  if (accountProjectionHasInventMoney(account)) {
    return unavailable(tool, 'balance_field_forbidden');
  }
  if (!account.userId.trim() || !account.kycTier.trim()) {
    return unavailable(tool, 'incomplete_account');
  }
  if (account.userId !== requester) {
    return unavailable(tool, 'account_owner_mismatch');
  }
  return {
    status: 'ok',
    tool: 'identity.account.read',
    account: { userId: account.userId, status: account.status, kycTier: account.kycTier },
  };
}

/**
 * Invoke one Stage-1-declared read tool.
 * Live + port → desk only. Live unwired → `no_live_kb`. Fixtures are test-only
 * (passed as a fixture port, never as a live stand-in).
 */
export async function invokeSupportDataTool(input: {
  tool: string;
  plane: SupportDeskPlane;
  /** Dark KB plane refuses even when the caller smuggled article fixtures. */
  kbPlane?: SupportKbPlane;
  /** The user asking. Row-scoped tools refuse when the row is not theirs. */
  requesterUserId: string;
  /** Product-law tier matrix. Blank → refuse-closed (no invent). */
  tierLaw?: SupportTierLaw | null;
  userTier?: string;
  /** Live ops.support / identity port. Absent on live → `no_live_kb`. */
  desk?: SupportDeskPort | null;
  /** Forwarded edge headers for ticket `get` (scopedProcedure). */
  deskHeaders?: Readonly<Record<string, string>>;
  kbQuery?: string | null;
  /** Owner-published KB search page size. Omit → named refuse, never invent 100. */
  kbSearchLimit?: number;
  articles?: readonly KbArticleFixture[] | null;
  ticket?: TicketFixture | null;
  account?: AccountProjectionFixture | null;
}): Promise<SupportDataToolResult> {
  const tool = input.tool.trim();

  if (isSupportMoneyTool(tool)) {
    return unavailable(tool, 'money_tool');
  }

  // The plane gate's own reason travels rather than being restated — hardcoding
  // `desk_plane_dark` here would mislabel every future refusal that gate learns.
  const grounded = supportGrounded({
    plane: input.plane,
    ...(input.kbPlane === undefined ? {} : { kbPlane: input.kbPlane }),
  });
  if (grounded.status === 'refuse') {
    return { status: 'refuse', tool, reason: grounded.reason, userMessageKey: grounded.userMessageKey };
  }

  const tier = supportTierGate({ law: input.tierLaw ?? null, userTier: input.userTier ?? '' });
  if (tier.status === 'refuse') {
    return tierRefuseToData(tool, tier);
  }

  const declared = new Set(supportAgentGuardrail().tools.map((t) => t.name));
  if (!declared.has(tool) || !isDeclaredDataTool(tool)) {
    return unavailable(tool, 'tool_not_declared');
  }

  if (!tier.allowedTools.includes(tool)) {
    return { status: 'refuse', tool, reason: 'tool_not_in_tier', userMessageKey: 'agents.support.tier_closed' };
  }

  const requester = input.requesterUserId.trim();
  if (!requester) {
    return unavailable(tool, 'missing_requester');
  }

  if (input.plane === 'live' && !input.desk) {
    return unavailable(tool, 'no_live_kb');
  }

  if (input.desk) {
    return invokeViaDesk(tool, requester, input.desk, input);
  }

  if (tool === 'support.kb.search') {
    let page: number;
    try {
      page = assertKbSearchPageLimit(input.kbSearchLimit);
    } catch (err) {
      if (err instanceof AgentError && err.code === 'agents.kb_search_limit_unset') {
        return {
          status: 'refuse',
          tool,
          reason: 'kb_search_limit_unset',
          userMessageKey: 'agents.refused.kb_search_limit_unset',
        };
      }
      throw err;
    }
    const articles = input.articles;
    if (!articles || articles.length === 0) {
      // No hit is a real answer — it means escalate, not improvise.
      return unavailable(tool, 'empty_results');
    }
    for (const a of articles) {
      if (!isKeyLike(a.articleKey) || !isKeyLike(a.titleKey) || !isKeyLike(a.bodyKey)) {
        return unavailable(tool, 'incomplete_article');
      }
    }
    return {
      status: 'ok',
      tool: 'support.kb.search',
      articles: articles.slice(0, page).map((a) => ({ articleKey: a.articleKey, titleKey: a.titleKey, bodyKey: a.bodyKey })),
    };
  }

  if (tool === 'support.ticket.read') {
    const ticket = input.ticket;
    if (!ticket) {
      return unavailable(tool, 'missing_fixture');
    }
    if (!ticket.ticketId.trim() || !ticket.category.trim()) {
      return unavailable(tool, 'incomplete_ticket');
    }
    if (!ticket.ownerUserId.trim()) {
      return unavailable(tool, 'incomplete_ticket');
    }
    if (ticket.ownerUserId !== requester) {
      return unavailable(tool, 'not_ticket_owner');
    }
    return {
      status: 'ok',
      tool: 'support.ticket.read',
      ticket: {
        ticketId: ticket.ticketId,
        ownerUserId: ticket.ownerUserId,
        status: ticket.status,
        category: ticket.category,
      },
    };
  }

  // identity.account.read
  const account = input.account;
  if (!account) {
    return unavailable(tool, 'missing_fixture');
  }
  // Refuse invent balances: a payload with money keys is not "status+KYC with
  // extras stripped" — stripping would silently invent a clean projection.
  if (accountProjectionHasInventMoney(account)) {
    return unavailable(tool, 'balance_field_forbidden');
  }
  if (!account.userId.trim() || !account.kycTier.trim()) {
    return unavailable(tool, 'incomplete_account');
  }
  if (account.userId !== requester) {
    return unavailable(tool, 'account_owner_mismatch');
  }
  return {
    status: 'ok',
    tool: 'identity.account.read',
    account: { userId: account.userId, status: account.status, kycTier: account.kycTier },
  };
}

/** True when the data tool succeeded. */
export function isSupportDataToolOk(result: SupportDataToolResult): result is SupportDataToolOk {
  return result.status === 'ok';
}

export type SupportAnswerDecision =
  | {
      readonly status: 'answer';
      /** The article keys the reply must be grounded in. Never empty. */
      readonly citedArticleKeys: readonly string[];
    }
  | {
      readonly status: 'escalate';
      readonly reason: 'kb_no_hit' | 'money_request' | 'desk_refused';
      readonly userMessageKey: 'agents.support.escalated';
    };

/**
 * The typed "I don't know" the tracker asks for.
 *
 * An assist layer that answers anyway when the KB missed is worse than no assist
 * layer — a wrong support answer is the one a user acts on. Three cases escalate
 * to a human ticket, and there is no fourth branch that guesses:
 *
 * - the KB read refused or came back empty (`desk_refused` / `kb_no_hit`)
 * - the user is asking for money to move — refunds and credits are `ops.support`
 *   requests and `pay`/`ledger` recipes, never an agent's sentence
 */
export function supportAnswerOrEscalate(input: { kbResult: SupportDataToolResult; moneyRequest?: boolean }): SupportAnswerDecision {
  if (input.moneyRequest === true) {
    return { status: 'escalate', reason: 'money_request', userMessageKey: 'agents.support.escalated' };
  }
  if (input.kbResult.status === 'refuse') {
    const reason = input.kbResult.reason === 'empty_results' || input.kbResult.reason === 'kb_empty' ? 'kb_no_hit' : 'desk_refused';
    return { status: 'escalate', reason, userMessageKey: 'agents.support.escalated' };
  }
  if (input.kbResult.tool !== 'support.kb.search') {
    return { status: 'escalate', reason: 'desk_refused', userMessageKey: 'agents.support.escalated' };
  }
  if (input.kbResult.articles.length === 0) {
    return { status: 'escalate', reason: 'kb_no_hit', userMessageKey: 'agents.support.escalated' };
  }
  return { status: 'answer', citedArticleKeys: input.kbResult.articles.map((a) => a.articleKey) };
}
