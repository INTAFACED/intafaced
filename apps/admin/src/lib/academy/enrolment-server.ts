import 'server-only';
import {
  ACADEMY_ADMIN_BULK_EMAIL,
  ACADEMY_ADMIN_BULK_EMAILS,
  ACADEMY_ADMIN_BULK_ENROL,
  ACADEMY_ADMIN_COURSE_INVITATIONS,
  ACADEMY_ADMIN_INVITE_TO_COURSE,
  ACADEMY_ADMIN_LEARNER_TAGS,
  ACADEMY_ADMIN_REPORT_FILE,
  ACADEMY_ADMIN_REPORT_TASKS,
  ACADEMY_ADMIN_REQUEST_LEARNER_EXPORT,
  ACADEMY_ADMIN_SEND_BULK_EMAIL,
  ACADEMY_ADMIN_STAFF_ENROL,
  ACADEMY_ADMIN_STAFF_ENROLMENTS,
  ACADEMY_ADMIN_TAG_LEARNERS,
} from '@intafaced/contracts/academy-admin-procedures';
import { identityLearnerCardResultSchema } from '@intafaced/contracts/identity-learner-card';
import {
  founderCall,
  founderAskedCall,
  founderRecordCall,
  parseWith,
  type FounderCallContext,
  type FounderCallResult,
  partFrom,
  type PartLabels,
  explainRefusal,
  type RefusalView,
} from '@/lib/desk';
import { ENROLMENT_COPY, type EnrolmentReply, type EnrolmentView, type MailView, type ReportsView } from './enrolment-model';

/**
 * Staff enrolment, invitations, course email and learner exports (J-academy-15), as the signed-in operator. Addresses
 * and handles are resolved to accounts one by one through identity's exact lookup (audited there); svc-academy records
 * the operator from their own token with the reason, and refuses by name. No money moves.
 */

const ACADEMY: PartLabels = {
  service: 'svc-academy',
  forbiddenMessage: 'svc-academy did not accept your session. These pages need the Academy operator permission (admin:read).',
  refusedMessage: (code) => (code ? enrolmentRefusal(code, 409).body : null),
};

function enrolmentRefusal(code: string | null, status: number, uncertain = false): RefusalView {
  const own = code ? ENROLMENT_COPY[code] : undefined;
  return own ? { ...own, code, changed: 'no' } : explainRefusal(code, status, uncertain);
}

const readCard = parseWith(identityLearnerCardResultSchema);

/** The account a whole email or handle names, through identity's exact lookup: its id, null when none, or why not known. */
async function accountOf(ctx: FounderCallContext, term: string): Promise<{ userId: string | null } | { failed: RefusalView }> {
  const value = term.trim();
  const input = value.startsWith('@') ? { handle: value.slice(1) } : value.includes('@') ? { email: value } : { handle: value };
  const found = await founderCall(ctx, 'identity', 'learnerCard.lookup', 'GET', input, readCard);
  if (found.kind === 'ok') return { userId: found.data.card?.id ?? null };
  const why = failure(found);
  return { failed: why.reply.ok ? enrolmentRefusal(null, 502, true) : why.reply };
}

/** One per line, trimmed, blank lines left out. */
export const linesOf = (text: unknown) =>
  typeof text === 'string'
    ? text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

function failure(result: FounderCallResult<unknown>): { status: number; reply: EnrolmentReply } {
  const refused = (code: string | null, status: number, uncertain = false) => ({
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false as const, ...enrolmentRefusal(code, status, uncertain) },
  });
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what: 'done', data: result.data } } : refused(null, 502, true);
    case 'refused':
      return refused(result.refusal.code, result.refusal.status);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403);
    case 'not_built':
      return refused('not_built', 501);
    case 'unavailable':
      return refused(null, 503, result.uncertain);
    case 'invalid':
      return refused(null, 502, true);
  }
}

const reply = (result: FounderCallResult<unknown>, what: string) => {
  const out = failure(result);
  return out.reply.ok ? { status: 200, reply: { ok: true as const, what, data: out.reply.data } } : out;
};

const incomplete = (body: string) => ({
  status: 400,
  reply: {
    ok: false as const,
    title: 'That request is not complete',
    body,
    next: 'Nothing was changed. Correct it and try again.',
    code: null,
    changed: 'no' as const,
  },
});

export async function loadEnrolment(ctx: FounderCallContext): Promise<EnrolmentView> {
  const [events, invitations, tags] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_STAFF_ENROLMENTS, {}),
    founderRecordCall(ctx, ACADEMY_ADMIN_COURSE_INVITATIONS, {}),
    founderRecordCall(ctx, ACADEMY_ADMIN_LEARNER_TAGS, undefined),
  ]);
  return {
    events: partFrom(events, (d) => d, ACADEMY),
    invitations: partFrom(invitations, (d) => d, ACADEMY),
    tags: partFrom(tags, (d) => d, ACADEMY),
    asOf: new Date().toISOString(),
  };
}

export async function loadMail(ctx: FounderCallContext, id: string | null): Promise<MailView> {
  const [history, detail] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_BULK_EMAILS, {}),
    id ? founderRecordCall(ctx, ACADEMY_ADMIN_BULK_EMAIL, { id }) : null,
  ]);
  return {
    history: partFrom(history, (d) => d, ACADEMY),
    detail: detail ? partFrom(detail, (d) => d, ACADEMY) : null,
    asOf: new Date().toISOString(),
  };
}

export async function loadReports(ctx: FounderCallContext): Promise<ReportsView> {
  const [tasks, tags] = await Promise.all([
    founderRecordCall(ctx, ACADEMY_ADMIN_REPORT_TASKS, undefined),
    founderRecordCall(ctx, ACADEMY_ADMIN_LEARNER_TAGS, undefined),
  ]);
  return { tasks: partFrom(tasks, (d) => d, ACADEMY), tags: partFrom(tags, (d) => d, ACADEMY), asOf: new Date().toISOString() };
}

/** A finished export's file, as svc-academy stored it, or why it cannot be served. */
export async function reportFile(ctx: FounderCallContext, id: string) {
  const result = await founderRecordCall(ctx, ACADEMY_ADMIN_REPORT_FILE, { id });
  return result.kind === 'ok' ? { ok: true as const, file: result.data } : failure(result);
}

type Body = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** One change from the console, by its `op`. */
export async function changeEnrolment(ctx: FounderCallContext, body: Body): Promise<{ status: number; reply: EnrolmentReply }> {
  switch (body.op) {
    case 'bulkEnrol': {
      const addresses = linesOf(body.addresses);
      if (addresses.length === 0) return incomplete('Paste at least one address, one per line.');
      const rows: Array<{ address: string; userId: string | null }> = [];
      for (const address of addresses) {
        // Only a whole address is looked up; anything else is sent as typed, so svc-academy names it.
        if (!address.includes('@')) {
          rows.push({ address, userId: null });
          continue;
        }
        const found = await accountOf(ctx, address);
        if ('failed' in found) return { status: 502, reply: { ok: false, ...found.failed } };
        rows.push({ address, userId: found.userId });
      }
      return reply(
        await founderAskedCall(ctx, ACADEMY_ADMIN_BULK_ENROL, { path: body.path, rows, reason: str(body.reason) }),
        'bulk enrolment answered',
      );
    }
    case 'staffEnrol': {
      const term = str(body.learner).trim();
      if (!term) return incomplete('Give the learner’s whole email or handle.');
      const found = await accountOf(ctx, term);
      if ('failed' in found) return { status: 502, reply: { ok: false, ...found.failed } };
      if (!found.userId) return { status: 404, reply: { ok: false, ...enrolmentRefusal('academy.learner_not_found', 404) } };
      return reply(
        await founderAskedCall(ctx, ACADEMY_ADMIN_STAFF_ENROL, { path: body.path, userId: found.userId, reason: str(body.reason) }),
        'learner enrolled',
      );
    }
    case 'invite':
      return reply(
        await founderAskedCall(ctx, ACADEMY_ADMIN_INVITE_TO_COURSE, {
          path: body.path,
          address: str(body.address),
          reason: str(body.reason),
        }),
        'invitation stored',
      );
    case 'bulkTag': {
      const terms = linesOf(body.learners);
      if (terms.length === 0) return incomplete('List the learners to tag, one whole email or handle per line.');
      const userIds: string[] = [];
      const missing: string[] = [];
      for (const term of terms) {
        const found = await accountOf(ctx, term);
        if ('failed' in found) return { status: 502, reply: { ok: false, ...found.failed } };
        if (found.userId) userIds.push(found.userId);
        else missing.push(term);
      }
      if (missing.length > 0)
        return {
          status: 404,
          reply: {
            ok: false,
            title: 'Some learners were not found',
            body: `No account has: ${missing.join(', ')}.`,
            next: 'Nobody was tagged. Correct the list and try again.',
            code: 'academy.learner_not_found',
            changed: 'no',
          },
        };
      const result = await founderAskedCall(ctx, ACADEMY_ADMIN_TAG_LEARNERS, {
        userIds: [...new Set(userIds)],
        tag: str(body.tag).trim(),
        reason: str(body.reason),
      });
      return reply(result, `tag ${str(body.tag).trim()} added`);
    }
    case 'sendMail':
      return reply(
        await founderAskedCall(ctx, ACADEMY_ADMIN_SEND_BULK_EMAIL, {
          path: body.path,
          subject: str(body.subject),
          body: str(body.body),
          key: str(body.key),
        }),
        'course email recorded',
      );
    case 'requestExport':
      return reply(
        await founderAskedCall(ctx, ACADEMY_ADMIN_REQUEST_LEARNER_EXPORT, { tag: str(body.tag).trim() || null, key: str(body.key) }),
        'learner export requested',
      );
    default:
      return incomplete('Unknown action.');
  }
}
