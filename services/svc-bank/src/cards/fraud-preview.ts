/**
 * BK-cops-09 (fraud half): the ML fraud risk preview for the card ops desk.
 *
 * There is no fraud engine. This is a labelled preview over TEST rows only:
 * it never changes an authorisation decision, posts no ledger line and sets no
 * freeze. The authorisation record gets no score field until an engine exists.
 *
 * No numbers are invented. A score is a named risk band and a block threshold
 * is a named stance; the numeric values a real engine would use are owner
 * values we do not have, so they are absent rather than sampled.
 */

export const FRAUD_PREVIEW_LABEL = 'Preview · sample data' as const;
export const FRAUD_PREVIEW_ENGINE = 'ML fraud risk score' as const;

export const FRAUD_RISK_BANDS = ['very_likely', 'neutral', 'very_unlikely'] as const;
export type FraudRiskBand = (typeof FRAUD_RISK_BANDS)[number];

export const FRAUD_SIGNALS = ['card_testing', 'merchant_dispute_risk', 'compromised_card'] as const;
export type FraudSignal = (typeof FRAUD_SIGNALS)[number];

export const FRAUD_BLOCK_STANCES = ['maximise_approval_rate', 'balanced', 'maximise_risk_prevention'] as const;
export type FraudBlockStance = (typeof FRAUD_BLOCK_STANCES)[number];

export interface FraudPreviewRow {
  /** TEST identifier; never a real authorisation id. */
  readonly testAuthorisationRef: string;
  readonly test: true;
  readonly band: FraudRiskBand;
  readonly signals: readonly FraudSignal[];
}

export interface FraudPreview {
  readonly label: typeof FRAUD_PREVIEW_LABEL;
  readonly engine: typeof FRAUD_PREVIEW_ENGINE;
  readonly preview: true;
  readonly blurred: true;
  readonly stances: readonly FraudBlockStance[];
  /** Automatic blocking is not a setting that can be on without an engine. */
  readonly automaticBlocking: 'unavailable';
  readonly rows: readonly FraudPreviewRow[];
}

/** Fixed TEST fixture, one row per band, covering every signal. Served from the back end, never from front-end constants. */
const TEST_ROWS: readonly FraudPreviewRow[] = Object.freeze([
  Object.freeze({
    testAuthorisationRef: 'TEST-AUTH-1',
    test: true,
    band: 'very_likely',
    signals: Object.freeze(['card_testing', 'compromised_card'] as const),
  }),
  Object.freeze({
    testAuthorisationRef: 'TEST-AUTH-2',
    test: true,
    band: 'neutral',
    signals: Object.freeze(['merchant_dispute_risk'] as const),
  }),
  Object.freeze({ testAuthorisationRef: 'TEST-AUTH-3', test: true, band: 'very_unlikely', signals: Object.freeze([] as const) }),
] as const);

export function fraudPreview(): FraudPreview {
  return {
    label: FRAUD_PREVIEW_LABEL,
    engine: FRAUD_PREVIEW_ENGINE,
    preview: true,
    blurred: true,
    stances: FRAUD_BLOCK_STANCES,
    automaticBlocking: 'unavailable',
    rows: TEST_ROWS,
  };
}

/** The typed Preview refusal: `kind: 'preview'`, never an allowlist code. */
export interface PreviewRefusal {
  readonly kind: 'preview';
  readonly engine: typeof FRAUD_PREVIEW_ENGINE;
  readonly action: FraudPreviewAction;
  readonly changed: false;
}

export const FRAUD_PREVIEW_ACTIONS = ['run_check', 'set_stance', 'automatic_blocking', 'model_feedback'] as const;
export type FraudPreviewAction = (typeof FRAUD_PREVIEW_ACTIONS)[number];

/** Every engine action refuses. Nothing is read or written. */
export function refuseFraudPreviewAction(action: FraudPreviewAction): PreviewRefusal {
  return { kind: 'preview', engine: FRAUD_PREVIEW_ENGINE, action, changed: false };
}
