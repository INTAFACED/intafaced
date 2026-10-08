/**
 * G-data (PTX-M06-R02–R05, R08–R10). Public tape is LIVE via TradeHub +
 * C4 L2 SBE. Completeness / origin / connected / remap claims refuse rather
 * than invent labels, native prints, a global connected lie, or a remapped
 * instrument. L2 is never L3. Mill sbe-l2-tape / trade/hub / routes are not recut.
 */

export type TapeLabelRefuseReason =
  | 'tape_label_unset'
  | 'origin_unset'
  | 'connected_lie'
  | 'instrument_remap'
  | 'l2_is_not_l3';

export type TapeLabelRefusal = {
  readonly ok: false;
  readonly reason: TapeLabelRefuseReason;
  readonly detail: string;
};

const LABELS = new Set(['aggressor', 'auction', 'liquidation', 'liq', 'block']);
const NATIVE = 'native';
const SYNTHETIC = new Set(['synthetic', 'implied']);

function refuse(reason: TapeLabelRefuseReason, detail: string): TapeLabelRefusal {
  return { ok: false, reason, detail };
}

function text(raw: string | boolean | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (raw === true) return 'named';
  const value = raw.trim().toLowerCase();
  return value.length === 0 ? null : value;
}

/** Completeness claim needs aggressor / auction / liq / block. Unknown is not a label. */
export function refuseUnlabelledTapeClaim(input: {
  readonly complete?: boolean;
  readonly kind?: string | null;
  readonly label?: string | null;
}): TapeLabelRefusal | null {
  if (input.complete !== true && input.kind === undefined && input.label === undefined) return null;
  const kind = text(input.kind) ?? text(input.label);
  if (input.complete === true && !kind) {
    return refuse('tape_label_unset', 'labelled tape claim refuses — kind is unknown, not aggressor/auction/liq/block');
  }
  if (kind && !LABELS.has(kind === 'liq' ? 'liq' : kind)) {
    return refuse('tape_label_unset', `kind ${kind} is not aggressor/auction/liq/block — refusing rather than inventing a label`);
  }
  if (input.complete === true && kind && !LABELS.has(kind === 'liquidation' ? 'liquidation' : kind)) {
    return refuse('tape_label_unset', 'labelled tape claim refuses — kind is unknown, not aggressor/auction/liq/block');
  }
  return null;
}

/** Synthetic / implied must be named. Native is not inferred. */
export function refuseUnsetTapeOrigin(input: {
  readonly origin?: string | null;
  readonly native?: boolean;
  readonly synthetic?: boolean;
  readonly implied?: boolean;
}): TapeLabelRefusal | null {
  const origin = text(input.origin);
  const claimsNative = input.native === true || origin === NATIVE;
  const isSynthetic = input.synthetic === true || input.implied === true || (origin !== null && SYNTHETIC.has(origin));
  if (claimsNative && isSynthetic) {
    return refuse('origin_unset', 'synthetic/implied print is not native — refusing rather than relabelling');
  }
  if (claimsNative && !origin) {
    return refuse('origin_unset', 'native claim without origin — refusing rather than inferring native');
  }
  if ((input.synthetic === true || input.implied === true) && !origin) {
    return refuse('origin_unset', 'synthetic/implied must be named distinct from native');
  }
  if (input.origin !== undefined && !origin) {
    return refuse('origin_unset', 'origin is unset — refusing rather than inferring native');
  }
  return null;
}

/** No global connected lie — per-source truth only. */
export function refuseGlobalConnectedLie(input: {
  readonly connected?: boolean;
  readonly depth?: boolean;
  readonly tradesBus?: boolean;
  readonly privateBus?: boolean;
}): TapeLabelRefusal | null {
  if (input.connected !== true) return null;
  if (input.depth === true && input.tradesBus === true && input.privateBus === true) return null;
  const sources = [input.depth, input.tradesBus, input.privateBus];
  if (sources.some((s) => s === false)) {
    return refuse('connected_lie', 'global connected refuses — a source is down');
  }
  return refuse('connected_lie', 'global connected refuses — per-source depth/trades/private is required');
}

/** Adapters cannot reinterpret instruments. */
export function refuseInstrumentRemap(input: {
  readonly listedMarketId?: string | null;
  readonly adapterMarketId?: string | null;
  readonly remap?: boolean;
}): TapeLabelRefusal | null {
  if (input.remap === true) {
    return refuse('instrument_remap', 'adapter cannot reinterpret an instrument — refusing the remap');
  }
  const listed = input.listedMarketId?.trim() ?? '';
  const adapter = input.adapterMarketId?.trim() ?? '';
  if (input.adapterMarketId !== undefined && !adapter) {
    return refuse('instrument_remap', 'adapter market id is blank — refusing rather than inventing an instrument');
  }
  if (listed && adapter && listed !== adapter) {
    return refuse('instrument_remap', `adapter ${adapter} cannot reinterpret listed ${listed}`);
  }
  return null;
}

/** L2 is not L3. Queue-probability from L2 alone is the same refuse. */
export function refuseL2AsL3(input: {
  readonly book?: string | null;
  readonly as?: string | null;
  readonly channel?: string | null;
}): TapeLabelRefusal | null {
  const book = text(input.book);
  const as = text(input.as) ?? text(input.channel);
  if (book === 'l2' && (as === 'l3' || as === 'queue' || as === 'queue-probability')) {
    return refuse('l2_is_not_l3', 'L2 is not L3 — refusing rather than calling the tape L3');
  }
  if (as === 'l3' || as === 'queue-probability') {
    return refuse('l2_is_not_l3', 'L2 is not L3 — refusing rather than calling the tape L3');
  }
  return null;
}

export function refuseLiveTapeData(input: {
  readonly complete?: boolean;
  readonly kind?: string | null;
  readonly label?: string | null;
  readonly origin?: string | null;
  readonly native?: boolean;
  readonly synthetic?: boolean;
  readonly implied?: boolean;
  readonly connected?: boolean;
  readonly depth?: boolean;
  readonly tradesBus?: boolean;
  readonly privateBus?: boolean;
  readonly listedMarketId?: string | null;
  readonly adapterMarketId?: string | null;
  readonly remap?: boolean;
  readonly book?: string | null;
  readonly as?: string | null;
  readonly channel?: string | null;
}): TapeLabelRefusal | null {
  return (
    refuseUnlabelledTapeClaim(input) ??
    refuseUnsetTapeOrigin(input) ??
    refuseGlobalConnectedLie(input) ??
    refuseInstrumentRemap(input) ??
    refuseL2AsL3(input)
  );
}
