import { BankError } from '../errors.js';

/**
 * Pay fiat rail names — mediation port, not a stored fiat ramp and not a ledger post.
 *
 * Tracker title: "Fiat on/off ramp reusing svc-pay adapters".
 * ADR split: fiat remains `socket.psp-partners` commercially. Kind fiat refuses
 * `bank.fiat_ramp_socket` before any row or ledger post — never a bank-local
 * PSP client, never an invented APY/BIN, never a second money book.
 *
 * svc-bank deliberately does **not** import `@intafaced/svc-pay`. Boot (or a
 * future contracts edge) may inject a port that asks pay's registry. Silence /
 * empty list = honest refuse. Kind fiat refuses `bank.fiat_ramp_socket` before
 * any row or ledger post. A live rail on this port is not a stored fiat ramp
 * and does not proceed to a ledger-client deposit or withdraw.
 *
 * Sandbox pay rails succeed on the pay side and must NOT launder into a bank
 * fiat ramp — that would invent a PSP. Today's registered pay offramp rail
 * (`bank-payout`) is `absent` and therefore refuses here the same as empty.
 */

export type PayFiatRampCapability = 'onramp' | 'offramp';

/** Same three-mode vocabulary as svc-pay `RailMode` — names only, no import. */
export type PayFiatRailMode = 'live' | 'sandbox' | 'absent';

export interface PayFiatRailSnapshot {
  readonly railId: string;
  readonly mode: PayFiatRailMode;
  readonly capabilities: readonly PayFiatRampCapability[];
}

/**
 * Narrow port. Implementations live at the process edge (boot wiring) or in
 * tests. Production default is {@link emptyPayFiatRampPort}.
 */
export interface PayFiatRampPort {
  listFiatRails(): readonly PayFiatRailSnapshot[] | Promise<readonly PayFiatRailSnapshot[]>;
}

/** Always-empty port — boot default until pay registry is wired across the edge. */
export const emptyPayFiatRampPort: PayFiatRampPort = {
  listFiatRails: () => [],
};

/**
 * Honest snapshot of in-repo svc-pay adapters (Phase A IN). Names only — this
 * service does not import `@intafaced/svc-pay`.
 *
 *   crypto-native — chain rail, not fiat settle
 *   card-sandbox  — sandbox succeeds on pay; must not launder into bank fiat
 *   bank-payout   — registered `absent`; every call refuses
 *
 * None of these can honestly move fiat. A live partner rail is Class X.
 */
export const IN_REPO_PAY_FIAT_RAILS: readonly PayFiatRailSnapshot[] = [
  { railId: 'crypto-native', mode: 'sandbox', capabilities: [] },
  { railId: 'card-sandbox', mode: 'sandbox', capabilities: ['onramp'] },
  { railId: 'bank-payout', mode: 'absent', capabilities: ['offramp'] },
];

export const inRepoPayFiatRampPort: PayFiatRampPort = {
  listFiatRails: () => IN_REPO_PAY_FIAT_RAILS,
};

/**
 * Empty / non-live rails must not present as a working fiat ramp.
 *
 * `simulated: false` or `looksLive: true` against an empty (or non-settling)
 * adapter list is the honesty bug this residual seals.
 */
export function assertEmptyRailsCannotLookLive(
  rails: readonly PayFiatRailSnapshot[],
  claim: { simulated: boolean; looksLive?: boolean },
): void {
  const canSettle = selectLivePayFiatRail(rails, 'onramp') !== null || selectLivePayFiatRail(rails, 'offramp') !== null;
  const looksLive = claim.simulated === false || claim.looksLive === true;
  if (looksLive && !canSettle) {
    throw new BankError(
      'A fiat ramp cannot look live when no svc-pay adapter can settle fiat — rails empty, sandbox, or absent. ' +
        'No invented FX. Socket remains socket.psp-partners.',
      'bank.fiat_ramp_no_pay_adapter',
    );
  }
}

/**
 * Pick a usable live pay rail for the capability. Sandbox and absent never win.
 */
export function selectLivePayFiatRail(
  rails: readonly PayFiatRailSnapshot[],
  capability: PayFiatRampCapability,
): PayFiatRailSnapshot | null {
  for (const rail of rails) {
    if (rail.mode !== 'live') continue;
    if (!rail.capabilities.includes(capability)) continue;
    if (!rail.railId.trim()) continue;
    return rail;
  }
  return null;
}

/**
 * Resolve the pay-adapter rail id for a fiat ramp leg, or refuse by socket name.
 *
 * Refusal text always names: (1) `socket.psp-partners`, (2) that the path is
 * svc-pay RailAdapter, (3) why the considered rails did not qualify.
 */
export async function resolvePayFiatRailId(port: PayFiatRampPort | null | undefined, capability: PayFiatRampCapability): Promise<string> {
  const rails = port ? await Promise.resolve(port.listFiatRails()) : [];
  const live = selectLivePayFiatRail(rails, capability);
  if (live) return live.railId;

  const summary =
    rails.length === 0
      ? 'no pay fiat rails registered (empty PayFiatRampPort / unset edge wire)'
      : rails.map((r) => `${r.railId}:${r.mode}[${r.capabilities.join('|') || '∅'}]`).join(', ');

  if (rails.length === 0) {
    throw new BankError(
      `Fiat ${capability} is socket.psp-partners — a bank/PSP partner and money-transmission permission, not inventable code. ` +
        `PayFiatRampPort is empty (unset edge wire / emptyPayFiatRampPort). No invented FX rate. Considered: ${summary}.`,
      'bank.fiat_ramp_no_pay_adapter',
    );
  }

  throw new BankError(
    `Fiat ${capability} has no live fiat rail on the injected svc-pay adapter. ` +
      `Sandbox/absent/capability-miss rails cannot host bank fiat; do not invent a PSP. ` +
      `No invented FX rate. Socket remains socket.psp-partners. Considered: ${summary}.`,
    'bank.no_fiat_rail',
  );
}
