/**
 * Typed refusals for the switched-off B2B ramp.
 *
 * The message is the code. A caller learns which rule refused, not a row,
 * a bank amount, or a licence attestation value.
 */
export type B2bRampCode =
  | 'pay.b2b_ramp_off'
  | 'pay.b2b_ramp_unreconciled'
  | 'pay.b2b_ramp_unavailable'
  | 'pay.b2b_ramp_amount_rejected'
  | 'pay.b2b_ramp_asset_rejected'
  | 'pay.b2b_ramp_line_rejected'
  | 'pay.b2b_ramp_not_found'
  | 'pay.merchant_not_found'
  | 'pay.team_role_forbidden';

export class B2bRampError extends Error {
  constructor(
    readonly code: B2bRampCode,
    readonly kind: 'refused' | 'unavailable' | 'not_found' | 'bad_request',
  ) {
    super(code);
    this.name = 'B2bRampError';
  }
}

/** Boot refusal. The message names the variable, never an attestation value. */
export class B2bRampBootError extends Error {
  readonly code = 'pay.b2b_ramp_boot_refused' as const;
  constructor(message: string) {
    super(message);
    this.name = 'B2bRampBootError';
  }
}
