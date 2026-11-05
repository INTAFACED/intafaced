import { MoneyError, parseAmount, formatAmount } from '@intafaced/ledger-client';
import type { OwnAgentDataClass, OwnAgentToolShape } from '@intafaced/contracts/agents-own';
import { FLEET_HARD_MONEY_WRITE_TOOLS, PRODUCT_AGENT_IDS } from '../fleet/guardrails.js';
import type { DataToolRefuseReason } from '../navigator/data-tools.js';
import type { ScannerDataToolRefuseReason } from '../scanner/data-tools.js';
import type { SupportDataToolRefuseReason } from '../support-agent/data-tools.js';

/**
 * AGENTS A PERSON BUILDS (AG-builder-01).
 *
 * A person's own agent starts from a template and may only use tools from the
 * addable catalogue below: read tools the product agents already declare, each
 * with the module it reads. Tools that move money are listed too, so the
 * builder can offer them and say why they are refused, and are never stored on
 * a draft. A blank spend cap stays blank: it blocks publishing and refuses a
 * session, it is never filled in.
 */

/**
 * The class of data a tool touches (AG-guardrails-01): the person's own data, market data, a draft the person still
 * sends, or a live write that acts in their name. The first use of a class asks the person's consent.
 */
export type OwnDataClass = OwnAgentDataClass;

/**
 * `module` is the module a tool reads, shown to the person; a money tool's is never granted. `shape` is the tool's
 * declared input and output (AG-tools-01), copied from the route that serves it, and `refusals` the reasons that route
 * can answer instead; null is a tool whose shape is not declared, which a person's agent cannot attach.
 */
export type OwnTool = {
  readonly name: string;
  readonly module: string;
  readonly movesMoney: boolean;
  /** Null for a money tool, which is never attached and so never used. */
  readonly dataClass: OwnDataClass | null;
  readonly shape: Readonly<OwnAgentToolShape> | null;
  readonly refusals: readonly string[];
};

/**
 * Each route's refusals, typed by the reason union it answers with, so a listed code is always one the route has.
 * Every tool on a route first passes the route's own gates (its plane, tier law and declared tools).
 */
const support = (...own: SupportDataToolRefuseReason[]): string[] => [
  ...own,
  ...(['desk_plane_dark', 'tier_law_blank', 'tier_not_granted', 'tool_not_declared', 'tool_not_in_tier', 'missing_requester'] as const),
];
const navigator = (...own: DataToolRefuseReason[]): string[] => [
  ...own,
  ...(['trade_plane_dark', 'tier_law_blank', 'tier_not_granted', 'tool_not_declared', 'tool_not_in_tier', 'money_write'] as const),
];
const scanner = (...own: ScannerDataToolRefuseReason[]): string[] => [
  ...own,
  ...([
    'market_plane_dark',
    'tier_law_blank',
    'tier_not_granted',
    'depth_invalid',
    'tool_not_declared',
    'tool_not_in_tier',
    'money_write',
  ] as const),
];

/** Each tool's shape from its route's input and output schema (router.ts and the module's data-tools.ts). */
const READ_TOOLS: readonly OwnTool[] = [
  {
    // router.ts support desk data tools (kbQuery); support-agent/data-tools.ts searchKb
    name: 'support.kb.search',
    dataClass: 'own_data',
    module: 'support',
    movesMoney: false,
    shape: {
      input: { kbQuery: 'text, up to 200 characters', limit: 'whole number from 1 to 500, the page size' },
      output: { articles: 'list of { articleKey, titleKey, bodyKey }' },
    },
    refusals: [...support('no_live_kb', 'kb_empty', 'empty_results', 'incomplete_article'), 'agents.kb_search_limit_unset'],
  },
  {
    // support-agent/data-tools.ts readTicket
    name: 'support.ticket.read',
    dataClass: 'own_data',
    module: 'support',
    movesMoney: false,
    shape: {
      input: { ticketId: 'text, up to 120 characters' },
      output: { ticket: '{ ticketId, ownerUserId, status, category }' },
    },
    refusals: support('missing_fixture', 'incomplete_ticket', 'not_ticket_owner', 'no_live_kb'),
  },
  {
    // support-agent/data-tools.ts readAccount: never a balance
    name: 'identity.account.read',
    dataClass: 'own_data',
    module: 'identity',
    movesMoney: false,
    shape: {
      input: { userId: 'text' },
      output: { account: '{ userId, status: active, frozen or closed, kycTier }' },
    },
    refusals: support('no_live_kb', 'incomplete_account', 'account_owner_mismatch', 'missing_fixture', 'balance_field_forbidden'),
  },
  {
    // navigator/data-tools.ts quote
    name: 'trade.quote',
    dataClass: 'market_data',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', last: 'decimal string', asOf: 'time' },
    },
    refusals: navigator('missing_fixture', 'incomplete_quote', 'invalid_decimal', 'stale'),
  },
  {
    // navigator and scanner data-tools.ts listMarkets
    name: 'trade.markets.list',
    dataClass: 'market_data',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { limit: 'whole number from 1 to 500, optional' },
      output: { markets: 'list of { marketId, symbol, status: open, halted or closed }' },
    },
    refusals: navigator('empty_markets', 'missing_fixture', 'markets_limit_unset'),
  },
  {
    // scanner/data-tools.ts ticker
    name: 'trade.ticker',
    dataClass: 'market_data',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', last: 'decimal string', volume24h: 'decimal string', change24hBps: 'whole number', asOf: 'time' },
    },
    refusals: scanner('missing_fixture', 'incomplete_ticker', 'invalid_decimal', 'stale'),
  },
  {
    // scanner/data-tools.ts bookTop
    name: 'trade.book.top',
    dataClass: 'market_data',
    module: 'trade',
    movesMoney: false,
    shape: {
      input: { marketId: 'text, up to 64 characters' },
      output: { marketId: 'text', bid: 'decimal string', ask: 'decimal string', asOf: 'time' },
    },
    refusals: scanner('missing_fixture', 'incomplete_book', 'invalid_decimal', 'stale'),
  },
  // An in-process runner tool of the merchant watch (merchant/session-run.ts), with no route and so no declared shape.
  {
    name: 'pay.metrics.read',
    dataClass: 'own_data',
    module: 'pay',
    movesMoney: false,
    shape: null,
    refusals: ['pay_plane_dark', 'no_live_metrics', 'stale', 'no_metrics'],
  },
];

/**
 * Tools that act in the person's name without moving value. Sending a comment on the person's own support ticket is a
 * live write: no rule may let it act without asking (ENGINE AP-7). Its door to the support desk is the approval flow's
 * (AG-approvals-01): until that is built, an admitted call refuses `agents.tool_not_wired` and sends nothing.
 */
const WRITE_TOOLS: readonly OwnTool[] = [
  {
    // support-agent/guardrail.ts declares it; support-agent/comment-draft.ts shapes its payload
    name: 'support.ticket.comment',
    dataClass: 'live_write',
    module: 'support',
    movesMoney: false,
    shape: {
      input: { ticketId: 'text, up to 120 characters', body: 'text, up to 4000 characters' },
      output: { ticketId: 'text', commented: 'yes' },
    },
    refusals: [],
  },
];

/** Offered so the refusal has a reason to show; `ledger.transfer` is how a person asks for one. */
const MONEY_TOOLS: readonly OwnTool[] = [
  { name: 'ledger.transfer', module: 'ledger', movesMoney: true, dataClass: null, shape: null, refusals: [] },
  ...FLEET_HARD_MONEY_WRITE_TOOLS.map((name) => ({
    name,
    module: name.split('.')[0]!,
    movesMoney: true,
    dataClass: null,
    shape: null,
    refusals: [],
  })),
];

/** The tools whose door a person's own agent can reach today; every other attachable tool refuses `agents.tool_not_wired`. */
export const OWN_TOOL_DOORS: ReadonlySet<string> = new Set(['support.kb.search']);

/** What any call of an attachable tool may meet before its door (AG-guardrails-01, -02): consent, the baseline, a rule. */
const GATE_REFUSALS = ['agents.consent_required', 'agents.baseline_value_unset', 'agents.rule_hand_off'];
const gated = (tool: OwnTool): OwnTool =>
  tool.movesMoney || !tool.shape
    ? tool
    : { ...tool, refusals: [...GATE_REFUSALS, ...(OWN_TOOL_DOORS.has(tool.name) ? [] : ['agents.tool_not_wired']), ...tool.refusals] };

export const OWN_TOOLS: readonly OwnTool[] = [...[...READ_TOOLS, ...WRITE_TOOLS].map(gated), ...MONEY_TOOLS];

export const OWN_TEMPLATES = {
  'service-starter': { tools: ['support.kb.search', 'support.ticket.read', 'identity.account.read'] },
  blank: { tools: [] },
} as const satisfies Record<string, { tools: readonly string[] }>;
export type OwnTemplate = keyof typeof OWN_TEMPLATES;
export const OWN_TEMPLATE_IDS = Object.keys(OWN_TEMPLATES) as OwnTemplate[];

/**
 * The templates offered to a person, from `AGENTS_OWN_TEMPLATES` (AG-catalogue-02): a comma-separated list of template
 * ids. Unset or blank offers every built-in template. `blank` is always offered, so "Start blank" is never taken away and a list
 * of just `blank` offers nothing else. An id that is not a template stops the service at boot, never at a call.
 */
export function parseOwnTemplates(value: string | undefined): readonly OwnTemplate[] {
  const ids = (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) return OWN_TEMPLATE_IDS;
  for (const id of ids) {
    if (!OWN_TEMPLATE_IDS.includes(id as OwnTemplate)) throw new Error(`AGENTS_OWN_TEMPLATES names an unknown template: ${id}`);
  }
  return OWN_TEMPLATE_IDS.filter((id) => id === 'blank' || ids.includes(id));
}

/** Words the Agents room uses in its own addresses, and the product agents' ids, are not names a person may take. */
export const RESERVED_NAMES: readonly string[] = [
  'new',
  'sessions',
  'catalogue',
  'activity',
  'coach',
  'campaigns',
  'limits',
  'usage',
  ...PRODUCT_AGENT_IDS,
];

export const NAME_MAX = 64;
export const INSTRUCTIONS_MAX = 4000;
/** How many agents one person may keep; a create past it refuses rather than filling the table. */
export const OWN_AGENTS_MAX = 50;
/** Postgres cannot store a NUL in text, so it refuses here with its reason instead of failing the write. */
const NUL = /\u0000/;

export type OwnRefusalCode =
  | 'agents.own.money_tool'
  | 'agents.tool_shape_missing'
  | 'agents.own.tool_unknown'
  | 'agents.own.reserved_name'
  | 'agents.own.name_too_long'
  | 'agents.own.instructions_too_long'
  | 'agents.own.cap_invalid'
  | 'agents.own.template_unknown'
  | 'agents.own.not_found'
  | 'agents.own.text_invalid'
  | 'agents.own.too_many'
  | 'agents.own.name_unset'
  | 'agents.own.surface_unknown'
  | 'agents.own.surface_not_reviewed'
  | 'agents.own.co_owner_group'
  | 'agents.own.co_owner_invalid'
  | 'agents.own.co_owner_self'
  | 'agents.own.co_owner_unread'
  | 'agents.own.co_owner_inactive'
  | 'agents.own.delete_unconfirmed'
  | 'agents.own.delete_published'
  | 'agents.own.delete_has_sessions'
  | 'agents.identity.lifetime_unset'
  | 'agents.identity.no_live_token'
  | 'agents.identity.token_unknown'
  | 'agents.identity.token_revoked'
  | 'agents.identity.token_expired'
  | 'agents.identity.owner_unread'
  | 'agents.identity.owner_frozen'
  | 'agents.identity.owner_inactive'
  | 'agents.assistant.engine_unavailable'
  | 'agents.assistant.description_blank'
  | 'agents.spend.cap_unset'
  | 'agents.spend.above_agent_cap'
  | 'agents.spend.per_call_above_session'
  | 'agents.usage.limit_invalid'
  | 'agents.usage.alert_above_limit'
  | 'agents.tool_not_declared'
  | 'agents.tool_not_wired'
  | 'agents.consent_required'
  | 'agents.consent_not_granted'
  | 'agents.rule_invalid'
  | 'agents.rule_hand_off'
  | 'agents.baseline_value_unset'
  | 'agents.baseline_loosen_refused'
  | 'agents.request_id_replay'
  | 'agents.approval.ttl_unset'
  | 'agents.approval.not_found'
  | 'agents.approval.decided'
  | 'agents.approval.rejected'
  | 'agents.approval.expired'
  | 'agents.approval.replaced'
  | 'agents.approval.input_invalid'
  | 'agents.eval.cases_empty'
  | 'agents.eval.too_many_cases'
  | 'agents.eval.case_blank'
  | 'agents.eval.case_too_long'
  | 'agents.eval.repeats_unset'
  | 'agents.eval.repeats_invalid'
  | 'agents.eval.threshold_unset'
  | 'agents.eval.threshold_invalid'
  | 'agents.test.ask_blank'
  | 'agents.test.tool_moves_no_value';

export class OwnAgentRefusal extends Error {
  constructor(
    readonly code: OwnRefusalCode,
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(code);
    this.name = 'OwnAgentRefusal';
  }
}

export type DraftInput = {
  readonly name: string;
  readonly instructions: string;
  readonly tools: readonly string[];
  /** Blank or absent is unset, never zero and never a default. */
  readonly perSessionCap: string | null | undefined;
};
export type DraftFields = { name: string; instructions: string; tools: string[]; perSessionCap: string | null };

/** Checks a draft as the person wrote it; refuses the first thing it cannot store, with its reason. */
export function validateDraft(input: DraftInput): DraftFields {
  if (NUL.test(input.name) || NUL.test(input.instructions)) throw new OwnAgentRefusal('agents.own.text_invalid');
  const name = input.name.trim();
  if (name.length > NAME_MAX) throw new OwnAgentRefusal('agents.own.name_too_long', { limit: String(NAME_MAX) });
  if (RESERVED_NAMES.includes(name.toLowerCase())) throw new OwnAgentRefusal('agents.own.reserved_name', { name });
  if (input.instructions.length > INSTRUCTIONS_MAX)
    throw new OwnAgentRefusal('agents.own.instructions_too_long', { limit: String(INSTRUCTIONS_MAX) });
  const tools: string[] = [];
  for (const raw of input.tools) {
    const tool = OWN_TOOLS.find((entry) => entry.name === raw.trim());
    if (!tool) throw new OwnAgentRefusal('agents.own.tool_unknown', { tool: raw });
    if (tool.movesMoney) throw new OwnAgentRefusal('agents.own.money_tool', { tool: tool.name });
    // A tool with no declared shape is never attached on a guess (AG-tools-01).
    if (!tool.shape) throw new OwnAgentRefusal('agents.tool_shape_missing', { tool: tool.name });
    if (!tools.includes(tool.name)) tools.push(tool.name);
  }
  return { name, instructions: input.instructions, tools, perSessionCap: parseCap(input.perSessionCap) };
}

function parseCap(cap: string | null | undefined): string | null {
  const text = cap?.trim() ?? '';
  if (!text) return null;
  try {
    const amount = parseAmount(text);
    if (amount <= 0n) throw new OwnAgentRefusal('agents.own.cap_invalid');
    return formatAmount(amount);
  } catch (err) {
    if (err instanceof MoneyError) throw new OwnAgentRefusal('agents.own.cap_invalid');
    throw err;
  }
}

export type Finding = { readonly code: 'agents.spend.cap_unset' | 'agents.own.name_unset'; readonly blocksPublishing: boolean };

/** What stops this draft being published. A blank cap is the person's to set; nothing fills it in. */
export function protectionFindings(fields: Pick<DraftFields, 'name' | 'perSessionCap'>): Finding[] {
  const findings: Finding[] = [];
  if (fields.perSessionCap === null) findings.push({ code: 'agents.spend.cap_unset', blocksPublishing: true });
  if (!fields.name) findings.push({ code: 'agents.own.name_unset', blocksPublishing: true });
  return findings;
}
