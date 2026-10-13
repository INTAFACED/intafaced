/**
 * Live OMS OCO/bracket that is not matching OCO refuses by field.
 * Matching `oco-link.ts` / `oco-cancel.ts` / `bracket.ts` already install
 * linked rest + guaranteed cancel of the other side — do not dual-implement.
 * OMS submit cannot cancel the sibling. Paper OCO/bracket stays paper.
 */
export type OmsOcoRefuseReason = 'oco_unsupported' | 'bracket_unsupported';

export type OmsOcoRefuseField = 'oco' | 'bracket' | 'takeProfit' | 'stopLoss' | 'ocoSiblingId' | 'kind';

export type OmsOcoRefusal = {
  readonly ok: false;
  readonly reason: OmsOcoRefuseReason;
  readonly field: OmsOcoRefuseField;
  readonly detail: string;
};

function present(raw: string | null | undefined): boolean {
  return raw !== undefined && raw !== null && raw.trim().length > 0;
}

const OCO_DETAIL = 'live OMS OCO is not matching OCO — refusing rather than placing one side without guaranteed cancel of the other';
const BRACKET_DETAIL =
  'live OMS bracket is not matching bracket — refusing rather than placing one side without guaranteed cancel of the other';

function kindOcoReason(kind: string | null | undefined): OmsOcoRefuseReason | null {
  const k = kind?.trim().toLowerCase();
  if (k === 'bracket') return 'bracket_unsupported';
  if (k === 'oco') return 'oco_unsupported';
  return null;
}

/**
 * Live OMS OCO/bracket is not matching OCO.
 * Refuse by field rather than silently submitting a single limit.
 */
export function refuseLiveOmsOco(input: {
  readonly oco?: boolean;
  readonly bracket?: boolean;
  readonly takeProfit?: string | null;
  readonly stopLoss?: string | null;
  readonly ocoSiblingId?: string | null;
  readonly kind?: string | null;
}): OmsOcoRefusal | null {
  if (input.bracket === true) {
    return { ok: false, reason: 'bracket_unsupported', field: 'bracket', detail: BRACKET_DETAIL };
  }
  if (input.oco === true) {
    return { ok: false, reason: 'oco_unsupported', field: 'oco', detail: OCO_DETAIL };
  }
  const fromKind = kindOcoReason(input.kind);
  if (fromKind) {
    return {
      ok: false,
      reason: fromKind,
      field: 'kind',
      detail: fromKind === 'bracket_unsupported' ? BRACKET_DETAIL : OCO_DETAIL,
    };
  }
  if (present(input.takeProfit)) {
    return { ok: false, reason: 'oco_unsupported', field: 'takeProfit', detail: OCO_DETAIL };
  }
  if (present(input.stopLoss)) {
    return { ok: false, reason: 'oco_unsupported', field: 'stopLoss', detail: OCO_DETAIL };
  }
  if (present(input.ocoSiblingId)) {
    return { ok: false, reason: 'oco_unsupported', field: 'ocoSiblingId', detail: OCO_DETAIL };
  }
  return null;
}
