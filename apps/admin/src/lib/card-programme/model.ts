/**
 * Pure model of the card programme desk (J-bank-26). Readers of svc-bank's answers, the words for each typed refusal,
 * and the one list of steps the browser may post. Nothing here sums or fills in a figure: every number is svc-bank's own,
 * and an unknown reads "not known".
 */

export const NOT_KNOWN = 'not known';

import type {
  BankCardAuthorizationDetail,
  BankCardholder,
  BankCardholderDetail,
  BankCardholderFunds,
  BankCardProgrammeDesk,
  BankCardProgrammeSetting,
  BankCardProgrammeSettingKey,
  BankCardTraceStep,
} from '@intafaced/contracts';

export type Setting = BankCardProgrammeSetting;
export type SettingKey = BankCardProgrammeSettingKey;
export type Desk = BankCardProgrammeDesk;
export type Settings = Desk['settings'];
export type ChecklistItem = Desk['checklist'][number];
export type Rule = Desk['rules'][number];
export type Staff = Desk['staff'][number];
export type AuditEntry = Desk['audit'][number];
export type Cardholder = BankCardholder;
export type CardRef = BankCardholderDetail['cards'][number];
export type Decision = Desk['decisionLog'][number];
export type Report = Desk['report'];
export type TraceStep = BankCardTraceStep;
export type Authorization = BankCardAuthorizationDetail;
export type Funds = BankCardholderFunds;
export type CardholderDetail = BankCardholderDetail;

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

export const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'bank.card_programme_viewer': 'Your card programme role is Viewer: you can read the programme but not change it. Nothing was changed.',
  'bank.card_programme_invalid': 'That was not accepted as written. Nothing was changed.',
  'bank.card_programme_staff_self': 'You cannot change your own card programme role.',
  'bank.card_rule_not_found': 'No such rule. Read the desk again.',
  'bank.card_rule_state': 'That rule step is not open in the rule’s state. Read the desk again.',
  'bank.cardholder_unverified': 'The cardholder fails the KYC or KYB gate and is in the review queue.',
  'bank.cardholder_under_review': 'The cardholder is in the review queue and can hold no new card.',
  'bank.cardholder_screening_unset':
    'The cardholder sanctions list is not set, so no cardholder can be screened or created. Nothing was saved.',
  'bank.cardholder_conflict': 'That request was already used for a different cardholder.',
  'bank.cardholder_not_found': 'No such cardholder.',
  'bank.card_bulk_invalid': 'The file has a bad row. Nothing was issued.',
  'bank.card_reassign_open_hold': 'This card has an authorisation still held for its holder. Nothing was moved.',
  'bank.card_reassign_same': 'The card already belongs to that cardholder.',
  'bank.card_sim_not_live': 'The card event simulator runs only on a dev or test stack, on simulated cards.',
  'bank.card_count_limit': 'The cardholder already holds as many cards as the programme allows. Nothing was moved or issued.',
  'bank.card_report_signing_unset': 'svc-bank has no signing secret, so no signed export can be made.',
  'bank.business_directory_unset': 'svc-bank cannot look accounts up here, so no account could be checked. Nothing was changed.',
  'bank.business_directory_unavailable': 'svc-identity did not answer the account lookup. Nothing was changed.',
};
export const refusalWords = (code: string | null): string | null =>
  code !== null && Object.hasOwn(REFUSAL_WORDS, code) ? REFUSAL_WORDS[code]! : null;

/** svc-bank names its code at the end of its message, `(bank.x)`; the typed cause wins when there is one. */
export function refusalCode(code: string | null, message: string): string | null {
  if (code && code.startsWith('bank.')) return code;
  return /\((bank\.[a-z0-9_]+)\)\s*$/.exec(message)?.[1] ?? code;
}

/** Every step the desk may post, and the svc-bank procedure each one calls. */
export const ACTIONS = {
  configure: 'ops.cardProgrammeConfigure',
  clearThreeDs: 'ops.cardProgrammeClearThreeDs',
  ruleCreate: 'ops.cardProgrammeRuleCreate',
  rulePromote: 'ops.cardProgrammeRulePromote',
  ruleRollback: 'ops.cardProgrammeRuleRollback',
  staffAssign: 'ops.cardProgrammeStaffAssign',
  cardholderCreate: 'ops.cardProgrammeCardholderCreate',
  bulkValidate: 'ops.cardProgrammeBulkValidate',
  bulkIssue: 'ops.cardProgrammeBulkIssue',
  reassign: 'ops.cardProgrammeReassign',
  simulate: 'ops.cardProgrammeSimulate',
  export: 'ops.cardProgrammeExport',
} as const;
export type ActionName = keyof typeof ACTIONS;

/** The posted step and its body for svc-bank, or null for anything not on the list. svc-bank checks every field. */
export function readAction(raw: unknown): { procedure: string; body: Record<string, unknown> | undefined } | null {
  if (!obj(raw) || !str(raw.action) || !Object.hasOwn(ACTIONS, raw.action)) return null;
  const action = raw.action as ActionName;
  const body = obj(raw.body) ? raw.body : undefined;
  const takesNoBody = action === 'clearThreeDs' || action === 'export';
  if (takesNoBody !== (body === undefined)) return null;
  return { procedure: ACTIONS[action], body };
}

export const RESULT_WORDS: Readonly<Record<TraceStep['result'], string>> = { pass: 'passed', decline: 'declined', skip: 'skipped' };
export const STATE_WORDS: Readonly<Record<Rule['state'], string>> = {
  shadow: 'Shadow (decides nothing)',
  active: 'Promoted',
  retired: 'Retired',
};
export const FUNDS_WORDS: Readonly<Record<Funds['status'], string>> = { matches: 'matches', break: 'break', not_known: NOT_KNOWN };
