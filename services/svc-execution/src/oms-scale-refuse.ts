/**
 * OMS extra kinds (scale/IS/sniper/trailing) refuse rather than dual-implement slice.
 * Live slice stays oms-slice.ts (twap|vwap|pov). Do not invent a second engine.
 */
export type OmsScaleUnsupportedRefuse = {
  readonly ok: false;
  readonly reason: 'scale_unsupported';
  readonly detail: string;
};

const EXTRA = new Set(['scale-in', 'scale-out', 'scale', 'implementation_shortfall', 'is', 'sniper', 'trailing', 'trailing-stop']);

/** Extra live OMS kinds refuse closed. Plain limits are not extras. */
export function refuseLiveOmsScaleExtra(input: { readonly kind?: string | null }): OmsScaleUnsupportedRefuse | null {
  const extraKind = input.kind?.trim().toLowerCase();
  if (!extraKind || !EXTRA.has(extraKind)) return null;
  return {
    ok: false,
    reason: 'scale_unsupported',
    detail: `live OMS kind ${String(input.kind)} is an extra — refusing rather than dual-implementing slice (twap|vwap|pov only)`,
  };
}
