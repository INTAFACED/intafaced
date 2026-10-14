/**
 * What a person told us, in plain words. Pure functions over the questionnaire answers the detail response carries.
 * Every enum is reworded (fix G7); amounts keep their exact digits and are labelled self-reported.
 */
import { countryName, formatMoney, humanEnum, labelOfKey, sentence, timingShort, volumeText } from './format';

export type Answers = Record<string, unknown>;
export type Fact = {
  key: string;
  label: string;
  value: string;
  /** True for what the person said about money: shown muted. */ selfReported?: boolean;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
/** "€250,000", "Undecided", or null when the answer is missing. */
export function indicativeText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('status' in value)) return null;
  if (value.status === 'stated' && 'amount' in value && 'currency' in value)
    return formatMoney(String(value.amount), String(value.currency));
  return 'Undecided';
}

/** Keys whose values are enums with their own wording (the rest are the person's own free text). */
const ENUM_KEYS = new Set(['investorType', 'participation', 'decisionRole', 'timing', 'experience', 'role', 'format', 'relationship']);
/** Keys that hold a list of enum values. */
const ENUM_LIST_KEYS = new Set(['markets', 'services']);

/** One answer, worded. Countries are named, amounts are formatted, lists are joined, every other enum is reworded. */
export function answerText(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (key === 'indicativeContribution') return indicativeText(value);
  if (key === 'processingVolume') {
    if (value && typeof value === 'object' && 'status' in value && value.status === 'stated')
      return volumeText(value as unknown as { amount: string; currency: string; period: string });
    return 'Not known';
  }
  if (key === 'operatingCountries')
    return Array.isArray(value) && value.length ? value.map((code) => countryName(String(code))).join(', ') : null;
  if (Array.isArray(value)) {
    if (!value.length) return null;
    return value.map((item) => (ENUM_LIST_KEYS.has(key) ? humanEnum(key, String(item)) : String(item))).join(', ');
  }
  if (typeof value === 'string') return ENUM_KEYS.has(key) ? humanEnum(key, value) : text(value);
  return String(value);
}

const LABELS: Record<string, string> = {
  investorType: 'Investor type',
  decisionRole: 'Role',
  participation: 'Takes part',
  indicativeContribution: 'Indicated amount',
  timing: 'Timing',
  platformInterest: 'Platform interest',
  businessName: 'Business',
  processingVolume: 'Processing volume',
  operatingCountries: 'Operating countries',
  learningGoal: 'Learning goal',
};
export const answerLabel = (key: string) => LABELS[key] ?? labelOfKey(key);

/** The few answers a founder wants first for each audience, in reading order. The rest are under "Full answers". */
const KEY_FIELDS: Record<string, string[]> = {
  investor: ['indicativeContribution', 'investorType', 'decisionRole', 'participation', 'timing'],
  trader: ['role', 'experience', 'markets', 'platformInterest', 'timing'],
  merchant: ['businessName', 'industry', 'processingVolume', 'operatingCountries', 'services', 'timing'],
  academy: ['learningGoal', 'experience', 'subjects', 'format', 'timing'],
  partner: ['expertise', 'relationship', 'scope', 'timing'],
};

/** The key answers for one audience as label and value pairs. Missing answers are left out, never shown as blanks. */
export function keyFacts(audience: string, answers: Answers | null): Fact[] {
  if (!answers) return [];
  const facts: Fact[] = [];
  for (const key of KEY_FIELDS[audience] ?? []) {
    const value = answerText(key, answers[key]);
    if (value) facts.push({ key, label: answerLabel(key), value, ...(key === 'indicativeContribution' ? { selfReported: true } : {}) });
  }
  return facts;
}

/** Every answer except the free-text message, in the order the questionnaire stores them. */
export function allFacts(answers: Answers | null): Fact[] {
  if (!answers) return [];
  return Object.entries(answers)
    .filter(([key]) => key !== 'message')
    .flatMap(([key, value]) => {
      const rendered = answerText(key, value);
      return rendered
        ? [{ key, label: answerLabel(key), value: rendered, ...(key === 'indicativeContribution' ? { selfReported: true } : {}) }]
        : [];
    });
}

/** The person's own message, or null. */
export const messageOf = (answers: Answers | null): string | null => text(answers?.message);

/* ------------------------------------------------------------------ list rows */

export type InvestorSignals = { type: string | null; role: string | null; timing: string | null };
export function investorSignals(answers: Answers | null): InvestorSignals {
  const type = text(answers?.investorType);
  const role = text(answers?.decisionRole);
  const timing = text(answers?.timing);
  return {
    type: type ? humanEnum('investorType', type) : null,
    role: role ? humanEnum('decisionRole', role) : null,
    timing: timing ? timingShort(timing) : null,
  };
}

/**
 * The one signal an "Everyone else" row shows: a merchant's volume and period, a trader's role, a partner's relationship,
 * an academy enquirer's format. Null while the answers have not loaded or the question was not answered.
 */
export function otherSignal(audience: string, answers: Answers | null): string | null {
  if (!answers) return null;
  switch (audience) {
    case 'merchant':
      return answerText('processingVolume', answers.processingVolume);
    case 'trader':
      return answerText('role', answers.role);
    case 'partner':
      return answerText('relationship', answers.relationship);
    case 'academy':
      return answerText('format', answers.format);
    default:
      return text(answers.timing) ? sentence(String(answers.timing)) : null;
  }
}

/** The answers for the audience the row is about, out of a detail response's submission. */
export function answersFor(
  submission: { questionnaires: ReadonlyArray<{ audience: string; answers: unknown }> } | null | undefined,
  audience: string,
): Answers | null {
  const found = submission?.questionnaires.find((questionnaire) => questionnaire.audience === audience);
  return found ? (found.answers as Answers) : null;
}
