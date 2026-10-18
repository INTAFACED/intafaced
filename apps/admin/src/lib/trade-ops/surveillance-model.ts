import { BLOCKERS } from './blockers';
import { blocked, refused, type Outcome } from './outcome';

/**
 * Pure rules for the Surveillance room. Reading cases is live: svc-matching's open cases come through svc-edge
 * (`GET /admin/trade-ops/surveillance/cases`). Recording a decision is the typed blocker surveillance_adjudicate_not_exposed:
 * svc-edge registers no adjudicate or fine route, on purpose. The law is built anyway: no automatic adjudication, no
 * invented sanction or fine.
 */

/** One open case exactly as svc-matching presents it. Nothing else (no id, window or detector) is invented here. */
export interface SurveillanceCase {
  readonly accountId: string;
  readonly marketId: string;
  /** The detector's own reason line. */
  readonly reason: string;
  readonly status: 'open';
}

/** Null when the body is not an array of cases in that shape: a guess is never shown. */
export function parseSurveillanceCases(raw: unknown): SurveillanceCase[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SurveillanceCase[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    if (typeof r.accountId !== 'string' || typeof r.marketId !== 'string' || typeof r.reason !== 'string' || r.status !== 'open')
      return null;
    out.push({ accountId: r.accountId, marketId: r.marketId, reason: r.reason, status: 'open' });
  }
  return out;
}

/** One detector as svc-matching reports it. `gap` is the service's own code when the detector is off (today `detector_gap`). */
export interface DetectorView {
  readonly enabled: boolean;
  readonly gap: string | null;
}
export interface DetectorsView {
  readonly spoofing: DetectorView;
  readonly layering: DetectorView;
}

function parseDetector(raw: unknown): DetectorView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return null;
  if (r.gap !== null && r.gap !== undefined && typeof r.gap !== 'string') return null;
  return { enabled: r.enabled, gap: typeof r.gap === 'string' ? r.gap : null };
}

/** Null (unknown) when the block is missing or not that shape: an unread detector is never shown as on. */
export function parseDetectors(raw: unknown): DetectorsView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const spoofing = parseDetector(r.spoofing);
  const layering = parseDetector(r.layering);
  return spoofing && layering ? { spoofing, layering } : null;
}

export interface DetectorLine {
  readonly name: 'Spoofing' | 'Layering';
  /** Why it is off: the service's gap code, or null when the state itself is unknown. */
  readonly gap: string | null;
  readonly state: 'off' | 'unknown';
}

/** The detectors that are not known to be on, in words the page can show above the table. Empty only when both are on. */
export function detectorLines(detectors: DetectorsView | null): DetectorLine[] {
  if (detectors === null)
    return [
      { name: 'Spoofing', gap: null, state: 'unknown' },
      { name: 'Layering', gap: null, state: 'unknown' },
    ];
  const out: DetectorLine[] = [];
  if (!detectors.spoofing.enabled) out.push({ name: 'Spoofing', gap: detectors.spoofing.gap, state: 'off' });
  if (!detectors.layering.enabled) out.push({ name: 'Layering', gap: detectors.layering.gap, state: 'off' });
  return out;
}

/** The empty-list sentence. With a detector off or unknown it never reads as "no abuse". */
export function surveillanceEmptyText(detectors: DetectorsView | null): string {
  const lines = detectorLines(detectors);
  if (lines.length === 0) return 'The matching engine reports no open cases.';
  if (detectors === null)
    return 'No open cases. The state of the spoofing and layering detectors is unknown, so this is not a sign that there is no spoofing or layering.';
  const names = lines.map((l) => l.name.toLowerCase()).join(' and ');
  return `No open cases. The ${names} ${lines.length === 1 ? 'detector is' : 'detectors are'} off, so this is not a sign that there is no ${names}.`;
}

export const DECISIONS = [
  { value: 'no_violation', label: 'No violation found' },
  { value: 'violation_confirmed', label: 'Violation confirmed' },
  { value: 'refer_to_compliance', label: 'Refer to compliance' },
] as const;
export type Decision = (typeof DECISIONS)[number]['value'];

export const LAW =
  'A person decides every case. The desk never adjudicates automatically and never proposes, invents or records a sanction or a fine. The service refuses both: auto_adjudicate_forbidden and invented_sanction.';

export type AdjudicationCheck =
  | { readonly ok: true; readonly body: { caseId: string; decision: Decision; rationale: string } }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Validate a human decision. Refuses automatic adjudication and any sanction/fine field with the service's own codes. */
export function checkAdjudication(input: Record<string, unknown>): AdjudicationCheck {
  if (input.auto === true || input.automatic === true || input.autoAdjudicate === true)
    return { ok: false, code: 'auto_adjudicate_forbidden', message: 'A case is decided by a person, never automatically.' };
  if ('sanction' in input || 'fine' in input || 'penalty' in input)
    return { ok: false, code: 'invented_sanction', message: 'The desk does not set a sanction or a fine. Record the decision only.' };
  const caseId = typeof input.caseId === 'string' ? input.caseId.trim() : '';
  if (caseId === '' || caseId.length > 128) return { ok: false, code: 'surveillance.bad_case', message: 'A case id is required.' };
  const decision = DECISIONS.find((d) => d.value === input.decision)?.value;
  if (!decision) return { ok: false, code: 'surveillance.bad_decision', message: 'Choose a decision.' };
  const rationale = typeof input.rationale === 'string' ? input.rationale.trim() : '';
  if (rationale.length < 12 || rationale.length > 1000)
    return {
      ok: false,
      code: 'surveillance.bad_rationale',
      message: 'The rationale must be 12 to 1000 characters; it is kept with the decision.',
    };
  return { ok: true, body: { caseId, decision, rationale } };
}

export function adjudicationOutcome(input: Record<string, unknown>): Outcome<never> {
  const c = checkAdjudication(input);
  return c.ok ? blocked(BLOCKERS.surveillance_adjudicate_not_exposed) : refused(c.code, c.message, 400);
}
