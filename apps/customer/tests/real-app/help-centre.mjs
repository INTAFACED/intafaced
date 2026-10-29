// The help centre's owner settings on the local stack (SP-help-centre-03), as a support lead sets them through Edge. The
// lead is the stack's founder A with the support desk staff scope on its own signed-in session; on a stack with no support
// staff yet it is appointed the first lead, which is the only appointment svc-support takes from someone who is not one.

let gates;
let ctx;
let pair;

async function founders() {
  gates ??= await import('../../../../tooling/scripts/local-test-gates.mjs');
  ctx ??= await gates.makeContext({ log: () => {} });
  pair ??= await gates.approverSessions(ctx);
  return { ctx, pair };
}

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** The settings a signed-out visitor reads. */
export async function helpCentre() {
  const { ctx } = await founders();
  return data(await ctx.edge.query('support', 'helpCentre'), 'helpCentre');
}

/** The published contact details a signed-out visitor reads. */
export async function contactChannels() {
  const { ctx } = await founders();
  return data(await ctx.edge.query('support', 'contactChannels'), 'contactChannels');
}

/** A token for founder A as a support lead. */
async function leadToken() {
  const { ctx, pair } = await founders();
  const token = await pair.a.supportOpsToken();
  const staff = data(await ctx.edge.query('support', 'staffList', undefined, token), 'staffList');
  const me = staff.find((member) => member.userId === pair.a.op.userId);
  if (me?.role === 'lead') return token;
  if (staff.length > 0)
    throw new Error(`founder A is not a support lead and this stack already has staff (${staff.length}); a lead must appoint it`);
  data(
    await ctx.edge.mutate(
      'support',
      'staffAppoint',
      { userId: pair.a.op.userId, role: 'lead', idempotencyKey: `journey:support-lead:${pair.a.op.userId}` },
      token,
    ),
    'staffAppoint',
  );
  return token;
}

/** Change the given settings from the revision just read. Returns the stored settings. */
export async function setHelpCentre(changes, reason) {
  const { ctx } = await founders();
  const token = await leadToken();
  const current = await helpCentre();
  return data(
    await ctx.edge.mutate('support', 'setHelpCentre', { ...changes, expectedRevision: current.revision, reason }, token),
    'setHelpCentre',
  );
}

/** Create or change a help library category as the support lead. */
export async function saveCategory(row) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'kbSaveCategory', row, await leadToken()), 'kbSaveCategory');
}

/** Create or change a section under a category as the support lead. */
export async function saveSection(row) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'kbSaveSection', row, await leadToken()), 'kbSaveSection');
}

/** Publish an article typed as text into a section. Returns the stored version. */
export async function publishText(row) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'kbPublishText', row, await leadToken()), 'kbPublishText');
}

/** Take an article off the help centre (a new hidden version). */
export async function unpublish(id, baseRevision) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'unpublishKb', { id, baseRevision }, await leadToken()), 'unpublishKb');
}

/** Vote counts per article version, as the support desk reads them (no reader id). */
export async function feedbackSummary() {
  const { ctx } = await founders();
  return data(await ctx.edge.query('support', 'kbFeedbackSummary', { limit: 500 }, await leadToken()), 'kbFeedbackSummary');
}

/** Narrow or widen who may read an article (public, signed_in, staff) as the support lead. */
export async function setAudience(id, baseRevision, audience) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'setKbAudience', { id, baseRevision, audience }, await leadToken()), 'setKbAudience');
}

/** A public reply from the support team on a request, written by the support lead. */
export async function replyAsLead(ticketId, body) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'comment', { ticketId, body }, await leadToken()), 'comment');
}

/** Move a request to a status as the support lead, with the reason on its trail. */
export async function setStatusAsLead(ticketId, status, note) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'setStatus', { ticketId, status, note }, await leadToken()), 'setStatus');
}

/** Define or change a ticket field (SP-tickets-03) as the support lead. */
export async function defineRequestField(row) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'defineRequestField', row, await leadToken()), 'defineRequestField');
}

/** Define or change a request type's form as the support lead. */
export async function defineRequestForm(row) {
  const { ctx } = await founders();
  return data(await ctx.edge.mutate('support', 'defineRequestForm', row, await leadToken()), 'defineRequestForm');
}

/** The desk group with this name, made by the support lead when the desk has none (the TEST fraud-report route). */
export async function ensureDeskGroup(name) {
  const { ctx } = await founders();
  const token = await leadToken();
  const groups = data(await ctx.edge.query('support', 'groupsList', undefined, token), 'groupsList');
  return (
    groups.find((group) => group.name === name) ??
    data(await ctx.edge.mutate('support', 'groupsSave', { name, idempotencyKey: `group:${name}` }, token), 'groupsSave')
  );
}

/** Set a request's priority and type as the support lead (SP-tickets-04). */
export async function setPropertiesAsLead(ticketId, priority, ticketType) {
  const { ctx } = await founders();
  return data(
    await ctx.edge.mutate(
      'support',
      'setProperties',
      { ticketId, priority, ticketType, reason: 'TEST', clientRequestId: `props:${ticketId}:${priority}:${ticketType}` },
      await leadToken(),
    ),
    'setProperties',
  );
}

// The desk tokens live 300 s (local-test-gates.mjs `mintOperatorToken`), and one worker runs many journey files, so a
// token is minted again once it is four minutes old instead of once per worker. A refused mint is not kept, so the next
// call tries again.
const DESK_TOKEN_FRESH_MS = 4 * 60_000;
const desks = { lead: undefined, agent: undefined };
function deskToken(slot, mint) {
  const held = desks[slot];
  if (held && Date.now() - held.at < DESK_TOKEN_FRESH_MS) return held.token;
  const next = { at: Date.now(), token: mint().catch((error) => ((desks[slot] = undefined), Promise.reject(error))) };
  desks[slot] = next;
  return next.token;
}
const deskLeadToken = () => deskToken('lead', leadToken);
const agentToken = () => deskToken('agent', appointAgent);

/** A token for founder B as a support agent, appointed by the lead (founder A) the first time. */
async function appointAgent() {
  const { ctx, pair } = await founders();
  const lead = await deskLeadToken();
  const token = await pair.b.supportOpsToken();
  const staff = data(await ctx.edge.query('support', 'staffList', undefined, lead), 'staffList');
  if (!staff.some((member) => member.userId === pair.b.op.userId))
    data(
      await ctx.edge.mutate(
        'support',
        'staffAppoint',
        { userId: pair.b.op.userId, role: 'agent', idempotencyKey: `journey:support-agent:${pair.b.op.userId}` },
        lead,
      ),
      'staffAppoint',
    );
  return token;
}

/**
 * One support desk call through Edge as the lead (founder A, 'lead') or the agent (founder B, 'agent'), answered as it came
 * back ({ status, json, text }), so a step can read a refusal as well as a success.
 */
export async function asDesk(who, kind, procedure, input) {
  const { ctx } = await founders();
  const token = who === 'lead' ? await deskLeadToken() : await agentToken();
  return kind === 'query' ? ctx.edge.query('support', procedure, input, token) : ctx.edge.mutate('support', procedure, input, token);
}

/** The user ids of the lead (founder A) and the agent (founder B). */
export async function deskPeople() {
  const { pair } = await founders();
  return { lead: pair.a.op.userId, agent: pair.b.op.userId };
}
