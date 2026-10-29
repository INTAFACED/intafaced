import 'server-only';
import {
  campaignCalendarSchema,
  campaignDefinitionInputSchema,
  campaignGateSchema,
  campaignSchema,
  campaignTransitionInputSchema,
  campaignUpdateInputSchema,
  campaignVoucherSchema,
  ruleLibraryEntrySchema,
  ruleLibrarySaveInputSchema,
  ruleTestInputSchema,
  ruleTestResultSchema,
  voucherIssueInputSchema,
  voucherListInputSchema,
  type Campaign,
  type CampaignAction,
  type CampaignDefinitionInput,
} from '@intafaced/contracts/campaigns-catalogue';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import type { CampaignDeskReply, CampaignDetailView, CampaignsDeskView } from './builder-model';

/**
 * The campaigns desk as the signed-in founder. svc-campaigns holds every campaign (`ops.campaigns.*`: `campaigns:ops` and
 * the session's second factor) and records the founder from their own token on every create, edit and move. Nothing
 * here moves money: a budget is a limit the reward saga draws on, never a balance.
 */

const CAMPAIGNS: PartLabels = {
  service: 'svc-campaigns',
  forbiddenMessage:
    'svc-campaigns did not accept your founder session. The campaigns desk needs the campaign operator permission (campaigns:ops) on a session signed in with your second factor.',
};

const readList = parseWith(campaignSchema.array());
const readCalendar = parseWith(campaignCalendarSchema);
const readGate = parseWith(campaignGateSchema);
const readCampaign = parseWith(campaignSchema);

export async function loadCampaignsDesk(ctx: FounderCallContext): Promise<CampaignsDeskView> {
  const [list, calendar] = await Promise.all([
    founderCall(ctx, 'campaigns', 'ops.campaigns.list', 'GET', undefined, readList),
    founderCall(ctx, 'campaigns', 'ops.campaigns.calendar', 'GET', undefined, readCalendar),
  ]);
  return {
    asOf: new Date().toISOString(),
    campaigns: partFrom(list, (d) => d, CAMPAIGNS),
    calendar: partFrom(calendar, (d) => d, CAMPAIGNS),
  };
}

/** One campaign by id (at any age), with the gate's answer for its stored revision and the platform time zone. */
export async function loadCampaignDetail(ctx: FounderCallContext, id: string): Promise<CampaignDetailView> {
  const [got, gate, platformTimeZone] = await Promise.all([
    founderCall(ctx, 'campaigns', 'ops.campaigns.get', 'GET', { id }, readCampaign),
    founderCall(ctx, 'campaigns', 'ops.campaigns.validate', 'GET', { id }, readGate),
    loadPlatformTimeZone(ctx),
  ]);
  const unknown = got.kind === 'refused' && got.refusal.code === 'campaign.unknown';
  const campaign: Part<Campaign | null> = unknown ? { kind: 'ok', data: null } : partFrom(got, (d) => d, CAMPAIGNS);
  return {
    asOf: new Date().toISOString(),
    campaign,
    gate: unknown ? null : partFrom(gate, (d) => d, CAMPAIGNS),
    platformTimeZone,
  };
}

/** A new draft has no campaign yet: only the platform time zone, so the builder can offer it. */
export async function loadPlatformTimeZone(ctx: FounderCallContext): Promise<string | null> {
  const calendar = await founderCall(ctx, 'campaigns', 'ops.campaigns.calendar', 'GET', undefined, readCalendar);
  return calendar.kind === 'ok' ? calendar.data.timeZone : null;
}

const CODE_SUFFIX = /\s*\[[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+\]\s*$/;

/**
 * The service's own sentence leads, with its code: svc-campaigns names every blank and every refusal, and a console
 * paraphrase would lose which one it was.
 */
function reply(result: FounderCallResult<Campaign | null>, what: string): { status: number; reply: CampaignDeskReply } {
  const refused = (code: string | null, status: number, message: string | null, uncertain = false) => {
    const view = explainRefusal(code, status, uncertain);
    const body = message?.replace(CODE_SUFFIX, '').trim();
    return {
      status: status >= 400 && status < 600 ? status : 502,
      reply: { ok: false as const, ...view, body: body || view.body },
    };
  };
  switch (result.kind) {
    case 'ok':
      return result.data ? { status: 200, reply: { ok: true, what, campaign: result.data } } : refused(null, 502, null, true);
    case 'refused':
      return refused(result.refusal.code, result.refusal.status, result.refusal.message);
    case 'forbidden':
      return refused(result.refusal.code ?? 'operator.denied', 403, result.refusal.code ? result.refusal.message : null);
    case 'not_built':
      return refused('not_built', 501, null);
    case 'unavailable':
      return refused(null, 503, null, result.uncertain);
    case 'invalid':
      return refused(null, 502, null, true);
  }
}

export type CheckedInput<T> = { ok: true; input: T } | { ok: false; why: string };

const check =
  <T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, why: string) =>
  (input: unknown): CheckedInput<T> => {
    const parsed = schema.safeParse(input);
    return parsed.success ? { ok: true, input: parsed.data } : { ok: false, why };
  };

export const checkCreate = check(
  campaignDefinitionInputSchema,
  'A campaign needs a name of up to 120 characters; times, weekdays, hours and regions must be in their own shapes.',
);
export const checkUpdate = check(campaignUpdateInputSchema, 'Which campaign, read at which revision, with which definition?');
export const checkMove = check(campaignTransitionInputSchema, 'Which campaign, read at which revision, and which move?');

type UpdateInput = { id: string; revision: number; definition: CampaignDefinitionInput };
type MoveInput = { id: string; action: CampaignAction; revision: number };

export async function createCampaign(ctx: FounderCallContext, input: CampaignDefinitionInput) {
  return reply(await founderCall(ctx, 'campaigns', 'ops.campaigns.create', 'POST', input, readCampaign), 'created');
}

export async function updateCampaign(ctx: FounderCallContext, input: UpdateInput) {
  return reply(await founderCall(ctx, 'campaigns', 'ops.campaigns.update', 'POST', input, readCampaign), 'saved');
}

export async function moveCampaign(ctx: FounderCallContext, input: MoveInput) {
  return reply(await founderCall(ctx, 'campaigns', 'ops.campaigns.transition', 'POST', input, readCampaign), input.action);
}

// ── Rule library (CM-eligibility-rules-02, J-campaigns-16 #4) ──────────────────────────────────────────────────────

const readRuleTest = parseWith(ruleTestResultSchema);
const readRuleEntry = parseWith(ruleLibraryEntrySchema);
const readRuleList = parseWith(ruleLibraryEntrySchema.array());

export const checkRuleTest = check(ruleTestInputSchema, 'Which rule, on which TEST fixture account?');
export const checkRuleSave = check(
  ruleLibrarySaveInputSchema,
  'A rule needs a name of up to 120 characters and a tree of groups and conditions.',
);

export type RuleReply<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly title: string; readonly body: string; readonly next: string; readonly code: string | null };

/** A rule door's answer: the data, or the service's own sentence and code. */
function ruleReply<T>(result: FounderCallResult<T>): { status: number; reply: RuleReply<T> } {
  if (result.kind === 'ok') return { status: 200, reply: { ok: true, data: result.data } };
  const code = result.kind === 'refused' || result.kind === 'forbidden' ? (result.refusal.code ?? null) : null;
  const status = result.kind === 'refused' ? result.refusal.status : result.kind === 'forbidden' ? 403 : 502;
  const message = result.kind === 'refused' ? result.refusal.message : null;
  const view = explainRefusal(code, status, result.kind !== 'refused' && result.kind !== 'forbidden');
  const body = message?.replace(CODE_SUFFIX, '').trim();
  return {
    status: status >= 400 && status < 600 ? status : 502,
    reply: { ok: false, title: view.title, body: body || view.body, next: view.next, code },
  };
}

export async function testRule(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.rules.test', 'GET', input, readRuleTest));
}

export async function saveRule(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.rules.library.save', 'POST', input, readRuleEntry));
}

export async function listRules(ctx: FounderCallContext) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.rules.library.list', 'GET', undefined, readRuleList));
}

// ── Vouchers (CM-vouchers-coupons-01, CM-campaign-types-01 T-3; J-campaigns-16 #9) ────────────────────────────────

const readVoucher = parseWith(campaignVoucherSchema);
const readVoucherList = parseWith(campaignVoucherSchema.array());

export const checkVoucherList = check(voucherListInputSchema, 'Which campaign?');
export const checkVoucherIssue = check(voucherIssueInputSchema, 'A voucher code is 4 to 32 letters, digits or hyphens.');

export async function listVouchers(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.campaigns.vouchers.list', 'GET', input, readVoucherList));
}

export async function issueVoucher(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.campaigns.vouchers.issue', 'POST', input, readVoucher));
}
