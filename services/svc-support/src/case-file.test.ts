import { describe, expect, it } from 'vitest';
import { supportCaseFileSchema, type AccountState, type SupportComment, type SupportKbArticle } from '@intafaced/contracts';
import { buildCaseFile, citeAccountState, citeComment, citeKbArticle, digestOf, groundingFor } from './case-file.js';

const TICKET = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OP = '33333333-3333-4333-8333-333333333333';
const USER = '11111111-1111-4111-8111-111111111111';
const AT = '2026-08-09T10:00:00.000Z';

const article: SupportKbArticle = {
  id: 'kb-account-access',
  titleKey: 'support.kb.account_access.title',
  bodyKey: 'support.kb.account_access.body',
};

const state: AccountState = { userId: USER, status: 'frozen', kycTier: 'basic' };

const comment: SupportComment = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ticketId: TICKET,
  authorId: USER,
  authorRole: 'user',
  visibility: 'public',
  body: 'my card ending 4321 was declined',
  createdAt: AT,
};

function ok(overrides: Partial<Parameters<typeof buildCaseFile>[0]> = {}) {
  const built = buildCaseFile({
    ticketId: TICKET,
    escalatedBy: OP,
    reason: 'account_state',
    summary: 'Account frozen; user cannot withdraw.',
    citations: [citeAccountState(state, AT)],
    grounding: groundingFor(state, AT),
    now: new Date(AT),
    ...overrides,
  });
  if (built.status !== 'ok') throw new Error(`expected ok, got refuse:${built.reason}`);
  return built.caseFile;
}

describe('case file — an escalation that can say what it read', () => {
  it('refuses an escalation that cites nothing', () => {
    const built = buildCaseFile({
      ticketId: TICKET,
      escalatedBy: OP,
      reason: 'other',
      summary: 'Escalating.',
      citations: [],
      grounding: { status: 'unread', reason: 'not_attempted' },
    });
    // The refusal is by CODE. This is the load-bearing assertion of the module:
    // a case file with no citations looks like context while carrying none.
    expect(built).toEqual({ status: 'refuse', reason: 'ungrounded' });
  });

  it('refuses an empty summary, including whitespace-only', () => {
    for (const summary of ['', '   ', '\n\t ']) {
      const built = buildCaseFile({
        ticketId: TICKET,
        escalatedBy: OP,
        reason: 'other',
        summary,
        citations: [citeKbArticle(article, AT)],
        grounding: { status: 'unread', reason: 'not_attempted' },
      });
      expect(built).toEqual({ status: 'refuse', reason: 'empty_summary' });
    }
  });

  it('a dark identity plane is NOT a refusal when something else was read', () => {
    // Refusing here would mean svc-identity being down blocks every escalation
    // on the desk, stranding users who already have a problem.
    const built = buildCaseFile({
      ticketId: TICKET,
      escalatedBy: OP,
      reason: 'technical',
      summary: 'Cannot log in.',
      citations: [citeKbArticle(article, AT)],
      grounding: groundingFor(null, AT),
    });
    expect(built.status).toBe('ok');
    if (built.status === 'ok') expect(built.caseFile.grounding).toEqual({ status: 'unread', reason: 'plane_dark' });
  });

  it('"we never looked" and "identity was down" are different facts', () => {
    // Both would have been `null` under a nullable field. They are not the same
    // and an escalation review has to be able to tell them apart.
    expect(groundingFor(null, AT)).toEqual({ status: 'unread', reason: 'plane_dark' });
    expect(groundingFor(state, AT)).toEqual({ status: 'read', state, readAt: AT });
  });
});

describe('citations are proof, not copies', () => {
  it('a comment citation does not carry the comment body anywhere', () => {
    const citation = citeComment(comment, AT);
    const serialised = JSON.stringify(citation);
    // The body is the single most likely place for an account detail to appear.
    expect(serialised).not.toContain('4321');
    expect(serialised).not.toContain(comment.body);
    expect(citation.digest).toBe(digestOf(comment.body));
    expect(citation.ref).toBe(comment.id);
  });

  it('a whole case file carries no cited content', () => {
    const caseFile = ok({
      citations: [citeAccountState(state, AT), citeKbArticle(article, AT), citeComment(comment, AT)],
    });
    const serialised = JSON.stringify(caseFile);
    expect(serialised).not.toContain('4321');
    // The account projection IS carried, deliberately — status and tier are the
    // facts the desk acted on and neither is PII. What must not appear is the
    // comment text and the rendered article copy.
    expect(serialised).not.toContain(comment.body);
    expect(caseFile.citations).toHaveLength(3);
  });

  it('the digest changes when the cited thing changes, and not otherwise', () => {
    const before = citeAccountState(state, AT);
    const unchanged = citeAccountState({ ...state }, '2026-08-09T12:00:00.000Z');
    const thawed = citeAccountState({ ...state, status: 'active' }, AT);
    expect(unchanged.digest).toBe(before.digest);
    expect(thawed.digest).not.toBe(before.digest);
  });

  it('a KB citation digests keys, so a translation edit does not invalidate history', () => {
    const sameKeys = citeKbArticle({ ...article }, AT);
    const differentArticle = citeKbArticle({ ...article, bodyKey: 'support.kb.other.body' }, AT);
    expect(sameKeys.digest).toBe(citeKbArticle(article, AT).digest);
    expect(differentArticle.digest).not.toBe(sameKeys.digest);
  });
});

describe('no money, and nowhere to put any', () => {
  it('the published case-file shape has no money field', () => {
    // Shape-level, like svc-identity's pii-isolation gate: a future field named
    // `amount` fails here rather than at a code review that might not happen.
    const keys = Object.keys(supportCaseFileSchema.shape);
    for (const banned of ['amount', 'currency', 'asset', 'value', 'balance', 'refund', 'payout', 'instruction', 'creditTo']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('the case-file shape has no identity-document field', () => {
    const keys = Object.keys(supportCaseFileSchema.shape);
    for (const banned of ['documentBytes', 'document', 'passport', 'selfie', 'fullName', 'dateOfBirth', 'nationalId', 'email', 'phone']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('money_request is a reason NAME and carries nothing with it', () => {
    const caseFile = ok({ reason: 'money_request', summary: 'User asks for a refund of a failed deposit.' });
    expect(caseFile.reason).toBe('money_request');
    // Round-trips through the published schema, which is the whole shape there
    // is — so there is no extra field an amount could have travelled in.
    const parsed = supportCaseFileSchema.parse(caseFile);
    expect(Object.keys(parsed).sort()).toEqual(['citations', 'createdAt', 'escalatedBy', 'grounding', 'reason', 'summary', 'ticketId']);
  });

  it('the schema itself refuses a zero-citation case file', () => {
    const caseFile = ok();
    const empty = { ...caseFile, citations: [] };
    // Belt and braces with buildCaseFile: the wire shape refuses it too, so an
    // ungrounded file cannot arrive from a caller that skipped the builder.
    expect(supportCaseFileSchema.safeParse(empty).success).toBe(false);
  });
});
