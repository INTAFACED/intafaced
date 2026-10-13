/**
 * OMS MMP helpers are not the matching book. Live execute MMP/mass-quote/
 * delta/vega refuses rather than dual-implement Wave E mass quote.
 * Mill files stay mill. Do not invent quantity, delta, or vega.
 */
export type OmsMmpUnsupportedRefuse = {
  readonly ok: false;
  readonly reason: 'mmp_unsupported';
  readonly detail: string;
};

const EXTRA_KIND = new Set(['mmp', 'mass-quote', 'mass_quote', 'mqq', 'market-maker', 'market_maker']);

function present(value: string | null | undefined): boolean {
  return value !== undefined && value !== null;
}

/** Extra live OMS MMP kinds and invented greeks refuse closed. Plain limits are not MMP. */
export function refuseLiveOmsMmp(input: {
  readonly kind?: string | null;
  readonly mmp?: boolean;
  readonly massQuote?: boolean;
  readonly delta?: string | null;
  readonly vega?: string | null;
}): OmsMmpUnsupportedRefuse | null {
  const extraKind = input.kind?.trim().toLowerCase();
  if (extraKind && EXTRA_KIND.has(extraKind)) {
    return {
      ok: false,
      reason: 'mmp_unsupported',
      detail: `live OMS kind ${String(input.kind)} is matching Wave E — refusing rather than dual-implementing MMP`,
    };
  }
  if (input.mmp === true || input.massQuote === true) {
    return {
      ok: false,
      reason: 'mmp_unsupported',
      detail: 'live OMS MMP/mass-quote is matching Wave E — refusing rather than dual-implementing MMP',
    };
  }
  if (present(input.delta) || present(input.vega)) {
    return {
      ok: false,
      reason: 'mmp_unsupported',
      detail: 'delta/vega are matching Wave E — refusing rather than inventing MMP greeks',
    };
  }
  return null;
}
