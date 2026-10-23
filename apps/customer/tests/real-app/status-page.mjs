// The founders' status page on the local stack (SP-status-01), as an operator sets it through Edge: the components and
// owner values, and readings entered by hand for a component.

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
  if (!row) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** What the founders have set: components, the three owner values and the revision. */
export async function statusDefinition() {
  const { ctx, pair } = await founders();
  return data(await ctx.edge.query('notify', 'statusPage.definition', undefined, await pair.a.tradeOpsToken()), 'statusPage.definition');
}

/** The page a visitor reads, as svc-notify answers it: components with their state and basis, and incidents. */
export async function statusRead() {
  const { ctx } = await founders();
  return data(await ctx.edge.query('notify', 'statusPage.read'), 'statusPage.read');
}

/** The founders' active incident templates. */
export async function incidentTemplates() {
  const { ctx, pair } = await founders();
  const res = await ctx.edge.query('notify', 'statusPage.templates.list', undefined, await pair.a.tradeOpsToken());
  if (!Array.isArray(res.json?.result?.data))
    throw new Error(`statusPage.templates.list refused (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** Define (or bring back) one incident template, or retire one with `retire: true`. */
export async function setIncidentTemplate(template, { retire = false } = {}) {
  const { ctx, pair } = await founders();
  const input = retire
    ? { id: template.id }
    : (({ id, name, group, title, body, impact, components }) => ({ id, name, group, title, body, impact, components }))(template);
  const res = await ctx.edge.mutate(
    'notify',
    retire ? 'statusPage.templates.retire' : 'statusPage.templates.define',
    input,
    await pair.a.tradeOpsToken(),
  );
  return data(res, retire ? 'statusPage.templates.retire' : 'statusPage.templates.define');
}

/** Change the definition from the revision it reads now. Fields left out stay as they are. */
export async function configureStatusPage(fields, reason = 'TEST journey J-support-public-07') {
  const { ctx, pair } = await founders();
  const { revision } = await statusDefinition();
  const res = await ctx.edge.mutate(
    'notify',
    'statusPage.configure',
    { ...fields, expectedRevision: revision, reason },
    await pair.a.tradeOpsToken(),
  );
  return data(res, 'statusPage.configure');
}

/** One reading of one component, entered by a founder with its source and time. */
export async function recordReading({ componentId, state, observedAt, source }) {
  const { ctx, pair } = await founders();
  const res = await ctx.edge.mutate(
    'notify',
    'statusPage.record',
    { componentId, state, observedAt, source },
    await pair.a.tradeOpsToken(),
  );
  return data(res, 'statusPage.record');
}

/** A founder's view of one status subscriber by address, with its delivery rows, or null when none is stored. */
export async function findSubscriber(email) {
  const { ctx, pair } = await founders();
  const res = await ctx.edge.query('notify', 'statusPage.subscriptions.find', { email }, await pair.a.tradeOpsToken());
  if (res.json?.result && res.json.result.data === null) return null;
  return data(res, 'statusPage.subscriptions.find');
}
