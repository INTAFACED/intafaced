/**
 * Payment-rail ids as a founder should read them. The ids come from svc-pay's rail
 * registry; an id this console does not know is shown as the service sent it, never
 * guessed at. The founder read carries no rail mode, so a name never claims TEST or
 * live: the raw id (for example `card-sandbox`) is printed beside it.
 */
const RAIL_NAMES: Readonly<Record<string, string>> = {
  'crypto-native': 'Crypto transfers',
  'card-sandbox': 'Cards',
  'bank-payout': 'Bank payouts',
};

export function railName(railId: string): string {
  return RAIL_NAMES[railId] ?? railId;
}

export const RAIL_NO_REASON = 'The rail did not report a reason.';

/**
 * svc-pay's typed rail-health reasons (`services/svc-pay/src/rails/rail-adapter.ts`:
 * RAIL_HEALTH_STALE, RAIL_RPC_UNSET, RAIL_SANDBOX_ONLY, RAIL_MARKED_DOWN,
 * RAIL_PROBE_FAILED, plus the `rail.unhealthy` fallback). The read carries the code as
 * the first word of `detail`, optionally followed by `key=value` facts
 * (`rail.health_stale ageMs=45000`). The seconds below mirror RAIL_HEALTH_MAX_STALENESS_MS.
 */
const STALE_AFTER_SECONDS = 30;

const CODE_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

type Facts = Readonly<Record<string, string>>;

const REASON_WORDS: Readonly<Record<string, (ok: boolean, facts: Facts) => string>> = {
  'rail.health_stale': (_ok, facts) => {
    const age = /^\d+$/.test(facts.ageMs ?? '') ? Number(facts.ageMs) : NaN;
    // Rounded up, so an age just past the limit never reads as the limit itself.
    const since = Number.isFinite(age) ? ` (the last one was ${Math.ceil(age / 1000)} seconds ago)` : '';
    return `No health report in the last ${STALE_AFTER_SECONDS} seconds${since}`;
  },
  'rail.probe_failed': () => 'The last health check failed, so the rail is treated as down',
  'rail.marked_down': () => 'An operator marked this rail down',
  'rail.rpc_unset': (ok) =>
    ok
      ? 'Running on the built-in test chain: no blockchain node is connected'
      : 'No blockchain node is connected, so the rail cannot send or confirm transfers',
  'rail.sandbox_only': () => 'Test acquirer only: it does not move real money',
  'rail.unhealthy': () => 'The rail reported itself unhealthy without saying why',
};

function parseReason(text: string): { readonly code: string; readonly facts: Facts } | null {
  const [code = '', ...rest] = text.split(/\s+/);
  if (!CODE_SHAPE.test(code)) return null;
  const facts: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) facts[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { code, facts };
}

/**
 * What to print in the Detail column. A rail that is down always says why: a typed
 * reason in plain words, else the service's own free text unchanged, otherwise a plain
 * statement that it sent none. A code this console does not know is shown as sent, never
 * guessed at. A rail that is up with nothing to add stays a dash.
 */
export function railDetail(rail: { readonly ok: boolean; readonly detail: string | null }): string {
  const text = rail.detail?.trim() ?? '';
  if (text === '') return rail.ok ? '—' : RAIL_NO_REASON;
  const parsed = parseReason(text);
  if (parsed === null) return text;
  const words = REASON_WORDS[parsed.code];
  if (words === undefined) return `The rail reported a reason this console does not know: ${text}`;
  return words(rail.ok, parsed.facts);
}
