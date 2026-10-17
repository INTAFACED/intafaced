import { BLOCKERS } from './blockers';
import { blocked, refused, type Outcome } from './outcome';

/**
 * Pure rules for the Surveillance room. The case store is on svc-matching and is not routed to operators, so
 * reading cases and recording a decision both return the typed blocker surveillance_not_routed. The shapes and
 * the law are built anyway: no automatic adjudication, no invented sanction or fine.
 */

export type Detector = 'spoofing' | 'layering';
export type CaseState = 'open' | 'under_review' | 'adjudicated';

export interface SurveillanceCase {
  readonly id: string;
  readonly market: string;
  readonly accountId: string;
  readonly detector: Detector;
  /** ISO start and end of the window the detector flagged. */
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly state: CaseState;
  /** Evidence lines supplied by the service. Never invented here. */
  readonly evidence: readonly string[];
}

export const DETECTORS: readonly Detector[] = ['spoofing', 'layering'];

export const DECISIONS = [
  { value: 'no_violation', label: 'No violation found' },
  { value: 'violation_confirmed', label: 'Violation confirmed' },
  { value: 'refer_to_compliance', label: 'Refer to compliance' },
] as const;
export type Decision = (typeof DECISIONS)[number]['value'];

export const LAW =
  'A person decides every case. The desk never adjudicates automatically and never proposes, invents or records a sanction or a fine. The service refuses both: auto_adjudicate_forbidden and invented_sanction.';

/** Reading cases: the service is not routed, so this is the honest answer for the page and the list action. */
export function readCasesOutcome(): Outcome<never> {
  return blocked(BLOCKERS.surveillance_not_routed);
}

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
  return c.ok ? blocked(BLOCKERS.surveillance_not_routed) : refused(c.code, c.message, 400);
}

export const STATE_LABEL: Record<CaseState, string> = { open: 'Open', under_review: 'Under review', adjudicated: 'Decided' };
