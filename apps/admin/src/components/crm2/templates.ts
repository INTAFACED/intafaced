/**
 * Reply and decline templates. These go out in a founder's name, so the wording is a DRAFT until Nitro approves it, and the
 * sheet that shows them says so. Nothing is sent from here: "Open in my email app" builds a mailto link and "Copy text" copies.
 *
 * Rules the wording keeps: no promise of an investment, a price, a return or a date; a stated amount is called indicative; no
 * claim that anything is committed. Placeholders are filled from the person's own answers and the signed-in founder.
 */
import { formatMoney, humanEnum } from './format';
import { answerText, type Answers } from './answers';
import type { DeclineReason } from './policy';

export const DRAFT_HEADER = "DRAFT: awaiting Nitro's approval of wording";

export type TemplateInput = {
  audience: string;
  /** The contact's full name. */
  name: string;
  /** The signed-in founder's name ("Nitro" or "Phantom"), or null when the names did not load. */
  founder: string | null;
  answers: Answers | null;
};
export type Draft = { subject: string; body: string };

export const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || 'there';
const signOff = (founder: string | null) => `Best wishes,\n${founder ?? 'The INTAFACED team'}\nINTAFACED`;

/** "an indicative €250,000" or null. */
function indicated(answers: Answers | null): string | null {
  const value = answers?.indicativeContribution;
  if (value && typeof value === 'object' && 'status' in value && value.status === 'stated' && 'amount' in value && 'currency' in value)
    return formatMoney(String(value.amount), String(value.currency));
  return null;
}

const SUBJECT = 'Your INTAFACED enquiry';

function investorReply({ name, founder, answers }: TemplateInput): Draft {
  const amount = indicated(answers);
  const type =
    typeof answers?.investorType === 'string' && answers.investorType !== 'other'
      ? humanEnum('investorType', answers.investorType).toLowerCase()
      : null;
  const timing = typeof answers?.timing === 'string' ? answerText('timing', answers.timing) : null;
  const lines = [
    `Hi ${firstNameOf(name)},`,
    '',
    `Thank you for your interest in INTAFACED${type ? ` as ${/^[aeiou]/i.test(type) ? 'an' : 'a'} ${type}` : ''}, and for taking the time to tell us about yourself.`,
    '',
  ];
  if (amount)
    lines.push(
      `You mentioned a figure of around ${amount}. That is a helpful starting point; it is indicative only, and nothing is committed on either side at this stage.`,
      '',
    );
  if (timing && timing !== 'Undecided') lines.push(`You said the timing would be: ${timing.toLowerCase()}.`, '');
  lines.push(
    'I would be glad to talk it through. Would a short call in the next week or two suit you? Send me a couple of times that work and I will confirm one.',
    '',
    'If there is anything you would like to understand before then, tell me and I will cover it on the call.',
    '',
    signOff(founder),
  );
  return { subject: SUBJECT, body: lines.join('\n') };
}

function merchantReply({ name, founder, answers }: TemplateInput): Draft {
  const volume = answerText('processingVolume', answers?.processingVolume);
  return {
    subject: SUBJECT,
    body: [
      `Hi ${firstNameOf(name)},`,
      '',
      'Thank you for telling us about your business and what you would like payments to do for it.',
      '',
      ...(volume && volume !== 'Not known'
        ? [`You mentioned processing around ${volume}. That helps us understand the shape of what you need.`, '']
        : []),
      'We are not onboarding merchants yet, but I would like to keep you close. Could you tell me a little more about how you take payments today, and what is hardest about it?',
      '',
      'We will write again as soon as we can invite merchants.',
      '',
      signOff(founder),
    ].join('\n'),
  };
}

function communityReply({ audience, name, founder }: TemplateInput): Draft {
  const what =
    audience === 'trader' ? 'trading with us' : audience === 'academy' ? 'learning with the INTAFACED Academy' : 'working with us';
  return {
    subject: SUBJECT,
    body: [
      `Hi ${firstNameOf(name)},`,
      '',
      `Thank you for telling us about your interest in ${what}.`,
      '',
      'We are not open to new members yet. You are on our early list, and we will write to you first when we open.',
      '',
      'If there is anything you would like us to know in the meantime, just reply to this email.',
      '',
      signOff(founder),
    ].join('\n'),
  };
}

function partnerReply({ name, founder, answers }: TemplateInput): Draft {
  const expertise = typeof answers?.expertise === 'string' ? answers.expertise.trim() : '';
  return {
    subject: SUBJECT,
    body: [
      `Hi ${firstNameOf(name)},`,
      '',
      `Thank you for getting in touch${expertise ? `, and for telling us about your work in ${expertise}` : ''}.`,
      '',
      'I would like to understand what you have in mind. Would you be open to a short call? Send me a couple of times that suit you and I will confirm one.',
      '',
      signOff(founder),
    ].join('\n'),
  };
}

/** The first reply for this person, written for their audience and filled from their answers. */
export function replyDraft(input: TemplateInput): Draft {
  switch (input.audience) {
    case 'investor':
      return investorReply(input);
    case 'merchant':
      return merchantReply(input);
    case 'partner':
      return partnerReply(input);
    default:
      return communityReply(input);
  }
}

const DECLINE_LINES: Record<DeclineReason, string[]> = {
  'Not a fit now': [
    'After looking at what you shared, we do not think we are the right fit for each other at this point, so we will not take this forward for now.',
    'That is not a judgement on you or your plans, and we are grateful you thought of us.',
  ],
  'Round full': [
    'We have now reached the size we set for this round, so we are not able to take on further participation.',
    'We are grateful for your interest and for the time you took to share it.',
  ],
  'Withdrawn by them': [
    'Thank you for letting us know. We have closed your enquiry as you asked, and nothing further will come from us about it.',
    'If your plans change, you are always welcome to get in touch again.',
  ],
  Waitlist: [
    'We are not able to take this forward right now, but we have put you on our waiting list.',
    'If a place opens or the situation changes, we will write to you first.',
  ],
};

/** A polite no, for the reason picked. It never gives a reason beyond the chip, and never mentions anyone else's enquiry. */
export function declineDraft(reason: DeclineReason, input: Pick<TemplateInput, 'name' | 'founder'>): Draft {
  return {
    subject: SUBJECT,
    body: [
      `Hi ${firstNameOf(input.name)},`,
      '',
      'Thank you for your enquiry to INTAFACED.',
      '',
      ...DECLINE_LINES[reason].flatMap((line) => [line, '']),
      signOff(input.founder),
    ].join('\n'),
  };
}

/** A mailto link to the address the person originally gave, with the subject and text ready. */
export function mailtoHref(email: string, draft: Draft): string {
  const encode = (value: string) => encodeURIComponent(value.replace(/\r?\n/g, '\r\n'));
  return `mailto:${email}?subject=${encodeURIComponent(draft.subject)}&body=${encode(draft.body)}`;
}
