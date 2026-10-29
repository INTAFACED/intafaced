/**
 * USER-FACING COPY — the only place in this service where a string reaches a
 * human.
 *
 * Two rules meet in this file.
 *
 * §14 DoD 4: "Every user-facing string i18n-keyed." So nothing here is emitted
 * as prose from a handler — the service returns a KEY plus parameters, and the
 * surface renders it. `EN` below is the reference catalogue, not the wire
 * format.
 *
 * Doctrine §0.7: "No third-party system names anywhere in UI, API responses, or
 * docs shipped to users." The model behind a completion is an implementation
 * detail of the gateway. In everything a user reads, the intelligence is
 * **Sovereign Intelligence**, the engine is the **Neural Engine**, and the
 * onboarding artefact is the **Identity Blueprint** — those three terms and no
 * others.
 *
 * That is why `AgentAction.userMessageKey` exists at all: if refusal text were
 * assembled ad hoc at the throw site, the vocabulary would drift the first time
 * someone debugged a routing problem and pasted a vendor's error string into a
 * message. Keeping every user-visible line in one enumerated table makes the
 * rule checkable — `copy.test.ts` asserts it from inside the package, and
 * `tooling/ci/brand-scan.mjs` asserts it from outside.
 */

export const COPY_KEYS = [
  'agents.session.opened',
  'agents.session.closed',
  'agents.action.completed',
  'agents.action.executed',
  'agents.usage.settled',
  'agents.usage.free',
  'agents.refused.tool_not_declared',
  'agents.refused.task_not_allowed',
  'agents.refused.tool_call_limit',
  'agents.refused.module_not_allowed',
  'agents.refused.step_limit',
  'agents.refused.spend_limit',
  'agents.refused.spend_limit_unset',
  'agents.refused.price_unset',
  'agents.refused.funds_insufficient',
  'agents.refused.funds_unread',
  'agents.refused.overage_grace_exceeded',
  'agents.refused.overage_grace_unset',
  'agents.refused.window_sealed',
  'agents.refused.spend_limit_invalid',
  'agents.refused.spend_cap',
  'agents.refused.spend_idempotency_conflict',
  'agents.refused.spend_reservation_conflict',
  'agents.refused.spend_reservation_missing',
  'agents.refused.spend_reservation_closed',
  'agents.refused.spend_hold_max_age_unset',
  'agents.refused.output_limit',
  'agents.refused.approval_required',
  'agents.refused.session_closed',
  'agents.refused.mode_unknown',
  'agents.refused.mode_forbids_write',
  'agents.refused.withdraw_scope_required',
  'agents.refused.place_idempotency_required',
  'agents.refused.place_key_conflict',
  'agents.refused.log_mine_limit_unset',
  'agents.refused.kb_search_limit_unset',
  'agents.error.route_not_found',
  'agents.error.capability_unavailable',
  'agents.error.engine_unavailable',
  'agents.error.window_sealed',
  'agents.error.window_unpaid',
  'agents.error.request_id_replay',
  'agents.scanner.empty',
  'agents.scanner.unavailable',
  'agents.scanner.tier_closed',
  'agents.scanner.signal_inputs_closed',
  'agents.scanner.rank_limit_unset',
  'agents.scanner.tickers_limit_unset',
  'agents.merchant.empty',
  'agents.merchant.unavailable',
  'agents.copy_intel.empty',
  'agents.copy_intel.unavailable',
  'agents.navigator.empty',
  'agents.navigator.unavailable',
  'agents.navigator.tier_closed',
  'agents.navigator.markets_limit_unset',
  'agents.support.empty',
  'agents.support.unavailable',
  'agents.support.comment_refused',
  'agents.support.tier_closed',
  'agents.support.escalated',
  'agents.refused.cursor_invalid',
  'agents.refused.fee_asset_unset',
] as const;

export type CopyKey = (typeof COPY_KEYS)[number];

/**
 * Reference English catalogue.
 *
 * `{placeholders}` are filled from an action's `userMessageParams`. A parameter
 * is always a value the user already knows about — a tool name they granted, a
 * limit they agreed to, an amount they were charged. Never a model id, never an
 * upstream error body, never a request identifier from outside the platform.
 */
export const EN: Readonly<Record<CopyKey, string>> = {
  'agents.session.opened': 'Sovereign Intelligence session opened for {agent}.',
  'agents.session.closed': 'Session closed. {steps} action(s) recorded.',

  'agents.action.completed': 'The Neural Engine answered for “{task}”.',
  'agents.action.executed': 'Ran {tool} inside your guardrails.',

  'agents.usage.settled': 'Metered usage for this session settled: {amount} {asset}.',
  'agents.usage.free': 'This session is on your included allowance — nothing was charged.',

  // Refusals. Each names the limit that stopped the action, because "refused"
  // without a reason is indistinguishable from a fault.
  'agents.refused.tool_not_declared': 'Refused: {tool} is not in this agent’s declared toolset, so it was not run.',
  'agents.refused.task_not_allowed': 'Refused: “{task}” is not among this agent’s allowed tasks.',
  'agents.refused.tool_call_limit': 'Refused: {tool} has already been used {limit} time(s) this session, which is its limit.',
  'agents.refused.module_not_allowed': 'Refused: this agent is not permitted to act in {module}.',
  'agents.refused.step_limit': 'Refused: this session has reached its limit of {limit} action(s).',
  'agents.refused.spend_limit': 'Refused: this session has reached its spend limit of {limit} {asset}.',
  'agents.refused.spend_limit_unset': 'Refused: set a spend limit before this run. No limit was given, and none was assumed.',
  'agents.refused.price_unset': 'Refused: no rate is published for this task, so it does not run. No price was assumed.',
  'agents.refused.funds_insufficient': 'Refused: your available balance is below this run’s worst case, so it did not start.',
  'agents.refused.funds_unread': 'Refused: your available balance could not be read, so this run did not start. Nothing was charged.',
  'agents.refused.overage_grace_exceeded':
    'Refused: {owed} {asset} of earlier usage is still unpaid, more than the {grace} {asset} allowed unpaid, so this run did not start. It is retried on its same charge before each run; add funds if your balance is short.',
  'agents.refused.overage_grace_unset':
    'Refused: {owed} {asset} of earlier usage is still unpaid, and no allowance for unpaid usage is set, so this run did not start. It is retried on its same charge before each run; add funds if your balance is short.',
  'agents.refused.window_sealed':
    'Refused: this session’s usage period is sealed, so it takes no more runs and nothing was called. Open a new session; usage still unpaid is retried on its same charge.',
  'agents.refused.spend_limit_invalid': 'Refused: that spend limit is blank or not a valid amount, so it was not saved.',
  'agents.refused.spend_cap': 'Refused: this would pass your {scope} spend limit of {limit} {asset}.',
  'agents.refused.spend_idempotency_conflict': 'Refused: this request key was already used for a different spend change.',
  'agents.refused.spend_reservation_conflict': 'Refused: this reservation key is already in use for a different amount or session.',
  'agents.refused.spend_reservation_missing': 'Refused: that spend reservation does not exist.',
  'agents.refused.spend_reservation_closed': 'Refused: this reservation is already finished, so it was not changed.',
  'agents.refused.spend_hold_max_age_unset': 'Refused: a maximum age for unfinished spend holds was not set, so none were released.',
  'agents.refused.output_limit': 'Refused: the request asked for more output than this agent is allowed to produce.',
  'agents.refused.approval_required': 'Held for your approval: {tool} needs you to confirm before it runs.',
  'agents.refused.session_closed': 'Refused: this session is closed. Start a new one to continue.',
  'agents.refused.mode_unknown': 'Refused: this session has no recognised trading mode, so {tool} was not run.',
  'agents.refused.mode_forbids_write': 'Refused: {mode} sessions cannot place, amend, cancel, or withdraw — {tool} was not run.',
  'agents.refused.withdraw_scope_required': 'Refused: agent credentials do not include withdrawal, so {tool} was not run.',
  'agents.refused.place_idempotency_required':
    'Refused: placing an order needs a stable intent key so a repeated message cannot duplicate it.',
  'agents.refused.place_key_conflict': 'Refused: this intent key is already in use for a place on this session, so {tool} was not run.',
  'agents.refused.log_mine_limit_unset': 'Refused: a page size is required for your activity log — none was given.',
  'agents.refused.cursor_invalid': 'Refused: that page cursor is not valid — ask for the list again from the start.',
  'agents.refused.fee_asset_unset': 'Refused: the fee asset for settled usage is unset, so spend cannot be labelled.',
  'agents.refused.kb_search_limit_unset': 'Refused: a page size is required to search support knowledge — none was given.',

  'agents.error.route_not_found': 'No Sovereign Intelligence route is configured for “{task}”.',
  'agents.error.capability_unavailable': 'The Neural Engine cannot serve this kind of request right now.',
  'agents.error.engine_unavailable': 'The Neural Engine is unavailable. Nothing was run and nothing was charged.',
  'agents.error.window_sealed': 'This usage period is already settled.',
  'agents.error.window_unpaid':
    'A usage window could not be paid, so the session stays open. Add funds: the window is retried on its same charge when you close the session or start a run.',
  'agents.error.request_id_replay':
    'That request was already processed for this session — start a new request rather than reusing the same id.',

  'agents.scanner.empty': 'No markets were provided to rank.',
  'agents.scanner.unavailable': 'Market signals are unavailable right now — quotes are missing or too old to trust.',
  'agents.scanner.tier_closed':
    'This Sovereign Intelligence scanner action is closed until product tier rules are published — nothing was invented or ranked.',
  'agents.scanner.signal_inputs_closed':
    'This Sovereign Intelligence scanner action is closed until market signal input rules are published — nothing was invented or ranked.',
  'agents.scanner.rank_limit_unset': 'Refused: a page size is required to rank markets — none was given.',
  'agents.scanner.tickers_limit_unset': 'Refused: a page size is required to list market quotes — none was given.',
  'agents.merchant.empty': 'No approval-rate samples were provided to watch.',
  'agents.merchant.unavailable': 'Approval-rate metrics are unavailable right now — samples are missing or too old to trust.',
  'agents.copy_intel.empty': 'No leader performance samples were provided.',
  'agents.copy_intel.unavailable': 'Leader stats are unavailable — samples are incomplete or the window is invalid.',
  'agents.navigator.empty': 'Nothing was asked, so nothing was looked up and nothing was charged.',
  'agents.navigator.unavailable': 'Market data is unavailable right now — the navigator will not invent quotes or routes.',
  'agents.navigator.tier_closed':
    'This Sovereign Intelligence navigator action is closed until product tier rules are published — nothing was invented or run.',
  'agents.navigator.markets_limit_unset': 'Refused: a page size is required to list markets — none was given.',
  'agents.support.empty': 'Nothing was asked, so nothing was looked up and nothing was charged.',
  'agents.support.unavailable': 'Support knowledge is unavailable right now — the desk will not invent an answer.',
  'agents.support.comment_refused': 'That comment cannot be posted — missing ticket, empty body, or forbidden invent language.',
  'agents.support.tier_closed':
    'This Sovereign Intelligence support action is closed until product tier rules are published — nothing was read or answered.',
  'agents.support.escalated': 'This one goes to a person — a support ticket has the answer, and nothing was guessed here.',
};

const KEY_SET: ReadonlySet<string> = new Set(COPY_KEYS);

export function isCopyKey(value: string): value is CopyKey {
  return KEY_SET.has(value);
}

/**
 * Render a key for logs and tests. Surfaces render from their own catalogues;
 * this exists so a developer reading `agent_actions` can see what the user saw.
 */
export function render(key: CopyKey, params: Readonly<Record<string, string | number>> = {}): string {
  return EN[key].replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** L3 — copy key catalog size. */
export function copyKeyCount(): number {
  return COPY_KEYS.length;
}

/** L3 — refused.* copy keys. */
export function refusedCopyKeys(): readonly CopyKey[] {
  return COPY_KEYS.filter((k) => k.startsWith('agents.refused.'));
}

/** L3 — board card. */
export function copyCatalogBoardCard(): {
  readonly total: number;
  readonly refused: number;
  readonly enCoverage: number;
} {
  return {
    total: copyKeyCount(),
    refused: refusedCopyKeys().length,
    enCoverage: Object.keys(EN).length,
  };
}

/** L3 — status line. */
export function copyCatalogStatusLine(): string {
  const c = copyCatalogBoardCard();
  return `total=${c.total} refused=${c.refused} en=${c.enCoverage}`;
}

/** L3 — parse status. Invalid → null. */
export function parseCopyCatalogStatusLine(line: string): { readonly total: number; readonly refused: number; readonly en: number } | null {
  const m = line.trim().match(/^total=(\d+) refused=(\d+) en=(\d+)$/);
  if (!m) return null;
  return { total: Number(m[1]), refused: Number(m[2]), en: Number(m[3]) };
}

/** L3 — true when status matches catalog. */
export function copyCatalogStatusLineMatches(): boolean {
  const p = parseCopyCatalogStatusLine(copyCatalogStatusLine());
  if (!p) return false;
  const c = copyCatalogBoardCard();
  return p.total === c.total && p.refused === c.refused && p.en === c.enCoverage;
}

/** L3 — true when EN covers every COPY_KEY (no invent gap). */
export function copyCatalogEnComplete(): boolean {
  return COPY_KEYS.every((k) => k in EN) && Object.keys(EN).length === COPY_KEYS.length;
}

/** L3 — export header. */
export function copyCatalogExportHeader(): string {
  return 'key';
}

/** L3 — export lines. */
export function copyCatalogExportLines(): readonly string[] {
  return COPY_KEYS.slice();
}

/** L3 — full export. */
export function copyCatalogExportText(): string {
  return [copyCatalogExportHeader(), ...copyCatalogExportLines()].join('\n');
}

/** L3 — true when total is within [min,max]. Invalid → false. */
export function copyKeyCountInRange(min: number, max: number): boolean {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return false;
  const n = copyKeyCount();
  return n >= min && n <= max;
}
