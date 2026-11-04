import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, openAgents, openOwnAgent } from './agents.mjs';
import { signIn, signUp } from './desk.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EDGE, ORIGIN, ROOT, api, json, restartWith, signOutBrowser, staffFreeze, staffRestore, tool } from './stack.mjs';

// J-agents-03, in the running app (docs/roadmap/journeys.json): create my own agent from a template, protect it and
// publish it. One test per step, titled "J-agents-03 #<n>", run in order on one verified TEST account, starting on
// /agents/new. Creating an agent moves no money. The assistant-drafting panel waits on the owner's model choice
// (owner.decision) while the rest of the builder works. The draft each step leaves is read back from svc-agents
// (own.* through Edge), not only from the page.
// #5's blank token lifetime and #6's unset model choice are the stack's TEST owner values switched off for one restart
// of svc-agents (restartWith), then back on. #5's frozen owner is a staff freeze of this run's account, lifted in the
// same step (staffFreeze, staffRestore), so #6 to #8 act as the same person.
const J = 'J-agents-03';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const SPARE = 'TEST spare draft';
const RENAMED = 'TEST renamed agent';
const DESCRIPTION = 'TEST: answer questions about my orders and never move money.';
/** The fields own.save takes, as svc-agents holds them. */
const pick = ({ id, name, instructions, tools, perSessionCap }) => ({ id, name, instructions, tools, perSessionCap });

/** The stack's TEST lifetime of an agent's token, in minutes (tooling/profiles/test-owner-values/agents.json). */
const TOKEN_LIFETIME_MINUTES = Number(
  JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/agents.json'), 'utf8')).values
    .AGENTS_OWN_TOKEN_LIFETIME_MINUTES.value,
);

/** A call the agent makes with its own token: through Edge, with no person's session. */
const agentCall = (token) =>
  fetch(`${EDGE}/api/agents/trpc/own.identity.agentCall`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then(json);

const main = (page) => page.getByRole('main');
const builder = (page) => main(page).getByRole('form', { name: 'Agent builder' });
const check = (page) => main(page).getByRole('region', { name: 'Protection check' });

/** One of the person's own agents service reads through Edge, on a sign-in of its own: the answer's data. */
async function ownRead(procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(agents.account())).get(`/api/agents/trpc/own.${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** The person's own agents, newest first, as svc-agents holds them. */
const ownAgents = () => ownRead('list', { limit: 200 });
/** The journey's own agent, as svc-agents holds it. */
async function ownAgent() {
  const named = (await ownAgents()).filter((row) => row.name === OWN_AGENT);
  expect(named).toHaveLength(1);
  return ownRead('get', { id: named[0].id });
}

async function openBuilder(page) {
  await signIn(page, agents.account());
  await page.goto('/agents/new');
  await expect(main(page).getByRole('heading', { name: 'New agent', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account on /agents/new`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag03', '10');
  await openBuilder(page);
});

test(`${J} #1 opens the template picker and chooses the service starter: a draft with its tools and no cap; a second copy is the next draft`, async ({
  page,
}) => {
  await openBuilder(page);
  // The starter's tools, as svc-agents publishes the template.
  const starter = (await ownRead('catalogue')).templates.filter((row) => row.id === 'service-starter');
  expect(starter).toHaveLength(1);
  const starterTools = starter[0].tools;
  expect(starterTools.length).toBeGreaterThan(0);
  const before = (await ownAgents()).map((row) => row.id);
  const picker = main(page).getByRole('region', { name: 'Templates' });
  await picker.getByRole('button', { name: 'Use the service starter' }).click();
  await expect(builder(page).getByRole('textbox', { name: /^Spend cap per session/ })).toHaveValue('');
  // Exactly the template's tools, each once, in its order.
  await expect(builder(page).getByRole('list', { name: 'Tools' }).getByRole('listitem').locator('code')).toHaveText(starterTools);
  const first = await builder(page).getByTestId('draft-id').innerText();
  expect(await ownRead('get', { id: first })).toMatchObject({
    template: 'service-starter',
    tools: starterTools,
    perSessionCap: null,
    state: 'draft',
    version: 1,
  });
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill(OWN_AGENT);
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');

  await page.goto('/agents/new');
  await picker.getByRole('button', { name: 'Use the service starter' }).click();
  const second = await builder(page).getByTestId('draft-id').innerText();
  expect(second).not.toBe(first);
  // A second draft of the same template, and the next one svc-agents holds: newest first, right after the first.
  expect((await ownAgents()).map((row) => row.id)).toEqual([second, first, ...before]);
  expect(await ownRead('get', { id: second })).toMatchObject({
    template: 'service-starter',
    tools: starterTools,
    perSessionCap: null,
    state: 'draft',
    version: 1,
  });
  // Kept as the spare draft #8 deletes.
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill(SPARE);
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');
});

test(`${J} #1 with no templates only the blank option shows`, async ({ page }) => {
  // svc-agents restarted offering no template but "Start blank" (AGENTS_OWN_TEMPLATES=blank, AG-catalogue-02): the
  // picker and the service's catalogue both show the blank option alone, and the starter comes back after.
  test.setTimeout(240_000);
  process.env.LOCAL_STACK_AGENTS_TEMPLATES = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'agents');
    await openBuilder(page);
    const picker = main(page).getByRole('region', { name: 'Templates' });
    await expect(picker.getByRole('button', { name: 'Start blank' })).toBeVisible();
    await expect(picker.getByRole('button')).toHaveCount(1);
    expect((await ownRead('catalogue')).templates.map((row) => row.id)).toEqual(['blank']);
  } finally {
    delete process.env.LOCAL_STACK_AGENTS_TEMPLATES;
    tool('local-test-stack.mjs', 'restart', 'agents');
  }
});

test(`${J} #2 edits the name, instructions and tools, adds a tool that moves money: the validator refuses it with its reason; "sessions" is reserved`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Build');
  const saved = await ownAgent();
  const alertWith = (code) =>
    builder(page)
      .getByRole('alert')
      .filter({ has: page.locator('code', { hasText: code }) });
  const INSTRUCTIONS = 'Answer TEST questions about my orders.';
  await builder(page)
    .getByRole('textbox', { name: /^Instructions/ })
    .fill(INSTRUCTIONS);
  await builder(page).getByRole('button', { name: 'Add a tool' }).click();
  await page
    .getByRole('dialog', { name: 'Add a tool' })
    .getByRole('option', { name: /ledger\.transfer/ })
    .click();
  const moneyTool = alertWith('agents.own.money_tool');
  await expect(moneyTool).toContainText('A tool that moves money cannot be added to an agent.');
  await expect(moneyTool.locator('code')).toHaveText('agents.own.money_tool');
  await expect(builder(page).getByRole('list', { name: 'Tools' }).getByRole('listitem').locator('code')).toHaveText(saved.tools);
  // The validator in svc-agents refuses it on its own, by the same code, when a save carries it past the page; the
  // draft it holds is unchanged.
  const refused = await (
    await api(agents.account())
  ).post('/api/agents/trpc/own.save', {
    id: saved.id,
    name: saved.name,
    instructions: INSTRUCTIONS,
    tools: [...saved.tools, 'ledger.transfer'],
    perSessionCap: saved.perSessionCap,
  });
  expect(refused.status).toBe(400);
  expect(refused.body.error.message).toBe('agents.own.money_tool');
  expect(await ownRead('get', { id: saved.id })).toEqual(saved);
  // "sessions" is reserved: the save is refused by its code and nothing in it is kept.
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill('sessions');
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  const reserved = alertWith('agents.own.reserved_name');
  await expect(reserved).toContainText('“sessions” is a reserved name.');
  await expect(reserved.locator('code')).toHaveText('agents.own.reserved_name');
  expect(await ownRead('get', { id: saved.id })).toEqual(saved);
  // svc-agents refuses the reserved name on its own, by the same code; the draft is still unchanged.
  const reservedSave = await (await api(agents.account())).post('/api/agents/trpc/own.save', { ...pick(saved), name: 'sessions' });
  expect(reservedSave.status).toBe(400);
  expect(reservedSave.body.error.message).toBe('agents.own.reserved_name');
  expect(await ownRead('get', { id: saved.id })).toEqual(saved);
  // A new name is saved and read back from svc-agents.
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill(RENAMED);
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');
  expect(await ownRead('get', { id: saved.id })).toMatchObject({ name: RENAMED, instructions: INSTRUCTIONS, tools: saved.tools });
  // With its own name back, the edited instructions and an added tool that only reads are saved.
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill(OWN_AGENT);
  await builder(page).getByRole('button', { name: 'Add a tool' }).click();
  await page
    .getByRole('dialog', { name: 'Add a tool' })
    .getByRole('option', { name: /trade\.quote/ })
    .click();
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');
  expect(await ownRead('get', { id: saved.id })).toMatchObject({
    name: OWN_AGENT,
    instructions: INSTRUCTIONS,
    tools: [...saved.tools, 'trade.quote'],
    perSessionCap: null,
  });
});

test(`${J} #3 reads the protection check: a blocking finding for the missing per-session cap`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Build');
  await expect(check(page).getByRole('listitem').filter({ hasText: 'No spend cap per session' })).toContainText('Blocks publishing');
});

test(`${J} #4 sets the cap and tool shapes: the finding clears; publish otherwise refuses with the unset-cap code`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Build');
  const draft = await ownAgent();
  expect(draft).toMatchObject({ perSessionCap: null, state: 'draft', version: 1 });
  expect(draft.findings).toContainEqual({ code: 'agents.spend.cap_unset', blocksPublishing: true });
  await main(page).getByRole('button', { name: 'Publish' }).click(UNBUILT);
  await expect(main(page).getByRole('alert').locator('code')).toHaveText('agents.spend.cap_unset');
  // Nothing was published: the draft svc-agents holds is unchanged, still version 1 and a draft.
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 1 · draft');
  expect(await ownRead('get', { id: draft.id })).toEqual(draft);
  await builder(page)
    .getByRole('textbox', { name: /^Spend cap per session/ })
    .fill('1');
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');
  await expect(check(page).getByRole('listitem').filter({ hasText: 'No spend cap per session' })).toHaveCount(0);
  await expect(check(page)).toContainText('Nothing blocks publishing this draft.');
  const capped = await ownRead('get', { id: draft.id });
  expect(capped).toMatchObject({ perSessionCap: '1', findings: [] });
});

test(`${J} #4 sets the cap and attaches tools: each attached tool shows its stored shapes and refusals; one with no declared shape is refused`, async ({
  page,
}) => {
  // AG-tools-01: each tool's input and output shape and its refusals are the service's stored registry, shown in the
  // builder and read back from own.catalogue; attaching a tool with no declared shape refuses agents.tool_shape_missing.
  await openOwnAgent(page, agents, 'Build');
  const draft = await ownAgent();
  const { tools: registry } = await ownRead('catalogue');
  const alertWith = (code) =>
    builder(page)
      .getByRole('alert')
      .filter({ has: page.locator('code', { hasText: code }) });
  const shapes = builder(page).getByRole('group', { name: 'Tool shapes' });
  await expect(shapes).toBeVisible();
  expect(draft.tools.length).toBeGreaterThan(0);
  const fields = (record) =>
    Object.entries(record)
      .map(([field, type]) => `${field}: ${type}`)
      .join('; ');
  for (const name of draft.tools) {
    const declared = registry.find((tool) => tool.name === name);
    expect(declared?.shape, `${name} has a declared shape`).toBeTruthy();
    const card = shapes.getByRole('article', { name, exact: true });
    await expect(card.getByTestId('shape-input')).toHaveText(fields(declared.shape.input));
    await expect(card.getByTestId('shape-output')).toHaveText(fields(declared.shape.output));
    await expect(card.getByTestId('shape-refusals')).toHaveText(declared.refusals.join(', '));
  }
  // A tool the registry declares no shape for: the builder says so, and the save is refused with its code and keeps
  // nothing; svc-agents refuses it the same way on its own.
  const shapeless = registry.find((tool) => !tool.movesMoney && tool.shape === null);
  expect(shapeless, 'the registry has a read tool with no declared shape').toBeTruthy();
  await builder(page).getByRole('button', { name: 'Add a tool' }).click();
  await page
    .getByRole('dialog', { name: 'Add a tool' })
    .getByRole('option', { name: new RegExp(shapeless.name.replace(/\./g, '\\.')) })
    .click();
  await expect(shapes.getByRole('article', { name: shapeless.name, exact: true })).toContainText(
    'Shape not declared: this tool cannot be attached.',
  );
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  const refused = alertWith('agents.tool_shape_missing');
  await expect(refused).toContainText('This tool has no declared shape, so it cannot be attached. Nothing was saved.');
  await expect(refused.locator('code')).toHaveText('agents.tool_shape_missing');
  expect(await ownRead('get', { id: draft.id })).toEqual(draft);
  const direct = await (
    await api(agents.account())
  ).post('/api/agents/trpc/own.save', {
    ...pick(draft),
    tools: [...draft.tools, shapeless.name],
  });
  expect(direct.status).toBe(400);
  expect(direct.body.error.message).toBe('agents.tool_shape_missing');
  expect(await ownRead('get', { id: draft.id })).toEqual(draft);
});

test(`${J} #5 opens the identity page: owner, scopes and expiry of the agent's own token; a revoke makes the next call fail; a blank token lifetime refuses; a frozen owner makes the token fail too`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const agent = await ownAgent();
  const ownerId = (await api(agents.account())).userId;
  const identityOf = () => ownRead('identity.get', { id: agent.id });
  const identity = () => main(page).getByRole('region', { name: 'Agent identity' });
  const facts = () => identity().getByTestId('agent-token-facts');

  // A blank token lifetime refuses: svc-agents restarted with no lifetime set issues nothing, and says why.
  const before = await identityOf();
  restartWith('agents', 'LOCAL_STACK_AGENTS_TOKEN_LIFETIME', false);
  try {
    await openOwnAgent(page, agents, 'Identity');
    await identity()
      .getByRole('button', { name: /^Issue (a new )?token$/ })
      .click();
    const refused = identity().getByRole('alert');
    await expect(refused.locator('code')).toHaveText('agents.identity.lifetime_unset');
    await expect(refused).toContainText('the owner has not set how long an agent’s token lasts. Nothing was issued.');
    await expect(identity().getByTestId('agent-token')).toHaveCount(0);
    expect(await identityOf()).toEqual(before);
  } finally {
    restartWith('agents', 'LOCAL_STACK_AGENTS_TOKEN_LIFETIME', true);
  }

  // With the lifetime set, the agent's own token: its owner, its scopes (the agent's tools) and its expiry, as
  // svc-agents holds them. The token itself is shown once.
  await openOwnAgent(page, agents, 'Identity');
  await identity()
    .getByRole('button', { name: /^Issue (a new )?token$/ })
    .click();
  const secret = await identity().getByTestId('agent-token').innerText();
  expect(secret).toMatch(/^agt_/);
  const { token } = await identityOf();
  expect(token).toMatchObject({ agentId: agent.id, ownerId, scopes: agent.tools, revokedAt: null, state: 'active' });
  expect(agent.tools.length).toBeGreaterThan(0);
  expect(Date.parse(token.expiresAt) - Date.parse(token.issuedAt)).toBe(TOKEN_LIFETIME_MINUTES * 60_000);
  for (const term of ['Owner', 'Scopes', 'Expires']) await expect(facts().getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(facts().getByTestId('token-owner')).toHaveText(ownerId);
  await expect(facts().getByRole('list', { name: 'Scopes' }).getByRole('listitem')).toHaveText(token.scopes);
  await expect(facts().getByTestId('token-expires')).toHaveAttribute('datetime', token.expiresAt);
  await expect(facts().getByTestId('token-state')).toHaveText('Active');

  // The agent's call with its own token answers who it acts as.
  const caller = { agentId: agent.id, ownerId, scopes: token.scopes, expiresAt: token.expiresAt };
  let call = await agentCall(secret);
  expect(call.status, JSON.stringify(call.body).slice(0, 300)).toBe(200);
  expect(call.body.result.data).toEqual(caller);

  // A frozen owner makes the token fail too; lifted, the same token answers again.
  const frozen = await staffFreeze(agents.account());
  expect(frozen).toBe(ownerId);
  try {
    call = await agentCall(secret);
    expect(call.status).toBe(403);
    expect(call.body.error.message).toBe('agents.identity.owner_frozen');
  } finally {
    await staffRestore(frozen);
  }
  call = await agentCall(secret);
  expect(call.status, JSON.stringify(call.body).slice(0, 300)).toBe(200);
  expect(call.body.result.data).toEqual(caller);

  // A revoke makes the next call fail.
  await openOwnAgent(page, agents, 'Identity');
  await identity().getByRole('button', { name: 'Revoke token' }).click();
  await expect(identity().getByRole('status')).toContainText('Revoked. The agent’s next call will fail.');
  await expect(facts().getByTestId('token-state')).toHaveText('Revoked');
  expect((await identityOf()).token).toMatchObject({ ...caller, state: 'revoked' });
  call = await agentCall(secret);
  expect(call.status).toBe(401);
  expect(call.body.error.message).toBe('agents.identity.token_revoked');
});

test(`${J} #6 asks the assistant to draft an agent: with the model unset the owner-decision notice and the builder still works; nothing saved until accepted`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  // svc-agents restarted with no model chosen for the assistant (the owner's decision), then the stack's TEST engine back.
  restartWith('agents', 'LOCAL_STACK_AGENTS_ASSISTANT_MODEL', false);
  try {
    await openBuilder(page);
    const before = await ownAgents();
    const assistant = main(page).getByRole('region', { name: 'Draft with the assistant' });
    const description = assistant.getByRole('textbox', { name: 'Describe the agent in plain words' });
    await description.fill(DESCRIPTION);
    await expect(description).toHaveValue(DESCRIPTION);
    await expect(assistant.getByRole('note')).toContainText('Drafting with the assistant waits on the owner’s choice of model.');
    await expect(assistant.getByRole('note').locator('code')).toHaveText('owner.decision');
    await expect(assistant.getByRole('button', { name: 'Draft it' })).toBeDisabled();
    // svc-agents refuses a draft on its own too, and drafts and saves nothing.
    const direct = await (await api(agents.account())).post('/api/agents/trpc/own.assistant.draft', { description: DESCRIPTION });
    expect(direct.status).toBe(412);
    expect(direct.body.error.message).toBe('owner.decision');
    expect(await ownAgents()).toEqual(before);
    // The rest of the builder still works without it: a blank draft is made, held by svc-agents, and edits save.
    await main(page).getByRole('region', { name: 'Templates' }).getByRole('button', { name: 'Start blank' }).click();
    const id = await builder(page).getByTestId('draft-id').innerText();
    const after = await ownAgents();
    expect(after.map((row) => row.id)).toEqual([id, ...before.map((row) => row.id)]);
    expect(after[0]).toMatchObject({ template: 'blank', tools: [], state: 'draft' });
    await builder(page).getByRole('textbox', { name: /^Name/ }).fill('TEST blank draft');
    await builder(page).getByRole('button', { name: 'Save draft' }).click();
    await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');
    expect(await ownRead('get', { id })).toMatchObject({ name: 'TEST blank draft', template: 'blank' });
  } finally {
    restartWith('agents', 'LOCAL_STACK_AGENTS_ASSISTANT_MODEL', true);
  }
});

test(`${J} #6 once the model choice is set a draft appears whose tools passed the validator; nothing is saved until accepted`, async ({
  page,
}) => {
  // The stack's model choice is its TEST engine, which drafts by rule and calls no model.
  await openBuilder(page);
  const before = await ownAgents();
  const { tools: catalogue } = await ownRead('catalogue');
  const assistant = main(page).getByRole('region', { name: 'Draft with the assistant' });
  const proposal = assistant.getByRole('region', { name: 'Proposed draft' });
  const describe = assistant.getByRole('textbox', { name: 'Describe the agent in plain words' });
  await expect(assistant).toContainText('TEST engine: it drafts by rule from your words and calls no model.');
  await expect(assistant.getByRole('note')).toHaveCount(0);

  // A tool the validator refuses never reaches the draft: asked for one that moves money, the draft leaves it out with
  // the validator's code.
  await describe.fill('TEST: answer questions and transfer my funds.');
  await assistant.getByRole('button', { name: 'Draft it' }).click();
  const leftOut = proposal.getByRole('list', { name: 'Left out by the check' }).getByRole('listitem');
  await expect(leftOut).toHaveText(['ledger.transfer · agents.own.money_tool']);
  await expect(proposal.getByRole('list', { name: 'Tools' }).getByRole('listitem')).toHaveText(['support.kb.search']);
  expect(await ownAgents()).toEqual(before);

  await describe.fill(DESCRIPTION);
  await assistant.getByRole('button', { name: 'Draft it' }).click();
  // A draft appears; each of its tools is one the validator admits: in the catalogue, with a declared shape, and none
  // moves money.
  const proposedTools = proposal.getByRole('list', { name: 'Tools' }).getByRole('listitem').locator('code');
  await expect(proposedTools.first()).toBeVisible();
  await expect(proposal.getByRole('list', { name: 'Left out by the check' })).toHaveCount(0);
  const proposed = await proposedTools.allInnerTexts();
  expect(proposed.length).toBeGreaterThan(0);
  for (const name of proposed) {
    const entry = catalogue.find((tool) => tool.name === name);
    expect(entry, name).toMatchObject({ movesMoney: false });
    expect(entry.shape, `${name} has a declared shape`).toBeTruthy();
  }
  const name = await proposal.getByTestId('proposal-name').innerText();
  // Nothing is saved until it is accepted.
  await expect(proposal).toContainText('Nothing is saved until you accept it.');
  expect(await ownAgents()).toEqual(before);
  await proposal.getByRole('button', { name: 'Accept' }).click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  const after = await ownAgents();
  expect(after).toHaveLength(before.length + 1);
  expect(after[0]).toMatchObject({ name, tools: proposed, state: 'draft' });
  expect(page.url()).toMatch(new RegExp(`/agents/${after[0].id}$`));
  // svc-agents' own validator held it: read back, the accepted draft carries exactly those tools and no money tool.
  const accepted = await ownRead('get', { id: after[0].id });
  expect(accepted.tools).toEqual(proposed);
  expect(accepted.tools.filter((tool) => catalogue.find((entry) => entry.name === tool)?.movesMoney !== false)).toEqual([]);
});

test(`${J} #7 publishes to a chosen surface, then edits and republishes: version 1 is immutable; the edit is a draft; republish moves one surface and running sessions keep their version; a surface the policy forbids is blocked with the reason`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Build');
  const agent = await ownAgent();
  expect(agent).toMatchObject({ state: 'draft', version: 1, perSessionCap: '1', findings: [] });
  const surfaces = main(page).getByRole('list', { name: 'Surfaces' });
  const surface = (name) => surfaces.getByRole('listitem').filter({ hasText: name });
  const versions = main(page).getByRole('list', { name: 'Published versions' });
  const carried = (publication) => Object.fromEntries(publication.surfaces.map((row) => [row.surface, row.version]));

  // Publishes to a chosen surface. A surface the policy forbids for a person's agent is offered but blocked, with the reason.
  await main(page).getByRole('button', { name: 'Publish' }).click(UNBUILT);
  const publish = page.getByRole('dialog', { name: 'Publish' });
  await expect(publish.getByRole('checkbox', { name: 'Public catalogue' })).toBeDisabled();
  await expect(publish).toContainText(
    'Not allowed for this agent: The public catalogue lists only agents the platform has reviewed, and an agent you build is not reviewed.',
  );
  await expect(publish.locator('code', { hasText: 'agents.own.surface_not_reviewed' })).toBeVisible();
  await publish.getByRole('checkbox', { name: 'My agents' }).check();
  await publish.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(publish).toBeHidden();
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 1 · published');
  await expect(surface('My agents')).toContainText('Version 1');
  await expect(surface('Chat')).toContainText('Not published');
  const first = await ownRead('publication', { id: agent.id });
  expect(first).toMatchObject({ version: 1, state: 'published' });
  expect(first.versions).toEqual([
    {
      version: 1,
      name: OWN_AGENT,
      instructions: agent.instructions,
      tools: agent.tools,
      perSessionCap: '1',
      publishedAt: expect.any(String),
    },
  ]);
  expect(carried(first)).toEqual({ my_agents: 1, chat: null, public_catalogue: null });
  expect(first.surfaces.find((row) => row.surface === 'public_catalogue')).toMatchObject({
    allowed: false,
    forbiddenCode: 'agents.own.surface_not_reviewed',
  });
  // svc-agents refuses the forbidden surface on its own, by the same code, and nothing is published or moved.
  const forbidden = await (
    await api(agents.account())
  ).post('/api/agents/trpc/own.publish', { id: agent.id, surfaces: ['public_catalogue'] });
  expect(forbidden.status).toBe(400);
  expect(forbidden.body.error.message).toBe('agents.own.surface_not_reviewed');
  expect(await ownRead('publication', { id: agent.id })).toEqual(first);

  // A session runs on version 1 (the person's limits for the agent set first, as Limits asks).
  const limits = await (
    await api(agents.account())
  ).post('/api/agents/trpc/own.limits.set', { id: agent.id, perCall: '0.5', perSession: '1', perPeriod: '5' });
  expect(limits.status, JSON.stringify(limits.body).slice(0, 300)).toBe(200);
  const tabs = page.getByRole('group', { name: 'Agent pages' });
  const sessionPanel = main(page).getByRole('region', { name: 'Session' });
  await tabs.getByRole('button', { name: 'Limits', exact: true }).click();
  await sessionPanel.getByRole('button', { name: 'Open a session' }).click();
  const running = sessionPanel.locator('code').first();
  await expect(running).toHaveText(/^[0-9a-f-]{36}$/);
  const runningId = await running.innerText();

  // Edits: version 1 stays as it was published; the edit is version 2, a draft.
  const EDITED = 'Answer TEST questions, briefly.';
  await tabs.getByRole('button', { name: 'Build', exact: true }).click();
  await builder(page)
    .getByRole('textbox', { name: /^Instructions/ })
    .fill(EDITED);
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('status')).toHaveText('Draft saved.');
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 2 · draft');
  expect(await ownRead('get', { id: agent.id })).toMatchObject({ version: 2, state: 'draft', instructions: EDITED });
  await expect(versions.getByRole('listitem')).toHaveCount(1);
  await expect(versions.getByRole('listitem').getByTestId('version-instructions')).toHaveText(agent.instructions);
  const edited = await ownRead('publication', { id: agent.id });
  expect(edited.versions).toEqual(first.versions);
  expect(carried(edited)).toEqual({ my_agents: 1, chat: null, public_catalogue: null });

  // Republishes to one surface: only Chat moves to version 2; My agents keeps version 1.
  await main(page).getByRole('button', { name: 'Publish' }).click();
  await expect(publish.getByRole('checkbox', { name: 'Public catalogue' })).toBeDisabled();
  await expect(publish).toContainText('Not allowed for this agent:');
  await publish.getByRole('checkbox', { name: 'Chat' }).check();
  await publish.getByRole('button', { name: 'Publish version 2' }).click();
  await expect(publish).toBeHidden();
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 2 · published');
  await expect(surface('Chat')).toContainText('Version 2');
  await expect(surface('My agents')).toContainText('Version 1');
  const republished = await ownRead('publication', { id: agent.id });
  expect(carried(republished)).toEqual({ my_agents: 1, chat: 2, public_catalogue: null });
  // Version 1 is immutable: exactly as first published, beside version 2.
  expect(republished.versions).toEqual([first.versions[0], expect.objectContaining({ version: 2, instructions: EDITED })]);
  await expect(versions.getByRole('listitem').getByTestId('version-instructions')).toHaveText([agent.instructions, EDITED]);

  // The running session keeps version 1; a session opened now runs version 2.
  const openSessions = main(page).getByRole('list', { name: 'Open sessions' });
  await expect(openSessions.getByRole('listitem').filter({ hasText: runningId })).toContainText('version 1');
  await tabs.getByRole('button', { name: 'Limits', exact: true }).click();
  await sessionPanel.getByRole('button', { name: 'Open a session' }).click();
  await expect(running).not.toHaveText(runningId);
  const newerId = await running.innerText();
  expect((await ownRead('publication', { id: agent.id })).openSessions).toEqual([
    { sessionId: runningId, version: 1 },
    { sessionId: newerId, version: 2 },
  ]);
  await tabs.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(openSessions.getByRole('listitem').filter({ hasText: runningId })).toContainText('version 1');
  await expect(openSessions.getByRole('listitem').filter({ hasText: newerId })).toContainText('version 2');
});

test(`${J} #8 shares the agent with a co-owner and deletes a spare draft: a group as co-owner is refused; deletion asks for an irreversible confirmation`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The co-owner: a second person, a TEST account of their own.
  const coOwner = await signUp(page, 'ag03co');
  const coOwnerId = (await api(coOwner)).userId;
  const ownerId = (await api(agents.account())).userId;
  await signOutBrowser(page.context());
  const agent = await ownAgent();

  await openOwnAgent(page, agents, 'Sharing');
  const share = main(page).getByRole('form', { name: 'Co-owners' });
  const field = share.getByRole('textbox', { name: /^Add a co-owner/ });
  // A group as co-owner is refused, and nothing is added.
  await field.fill('group:TEST-team', UNBUILT);
  await share.getByRole('button', { name: 'Add' }).click();
  const refusal = share.getByRole('alert');
  await expect(refusal).toContainText('A group cannot be a co-owner.');
  await expect(refusal.locator('code')).toHaveText('agents.own.co_owner_group');
  expect(await ownRead('coOwners.list', { id: agent.id })).toEqual([]);
  // svc-agents refuses a group on its own, by the same code.
  const group = await (await api(agents.account())).post('/api/agents/trpc/own.coOwners.add', { id: agent.id, coOwner: 'group:TEST-team' });
  expect(group.status).toBe(400);
  expect(group.body.error.message).toBe('agents.own.co_owner_group');
  expect(await ownRead('coOwners.list', { id: agent.id })).toEqual([]);
  // One person is added as co-owner, and they see the agent shared with them.
  await field.fill(coOwnerId);
  await share.getByRole('button', { name: 'Add' }).click();
  await expect(share.getByRole('status')).toHaveText('Co-owner added.');
  await expect(share.getByRole('list', { name: 'Current co-owners' }).getByRole('listitem')).toHaveText([new RegExp(coOwnerId)]);
  expect((await ownRead('coOwners.list', { id: agent.id })).map((row) => row.userId)).toEqual([coOwnerId]);
  const shared = await (
    await api(coOwner)
  ).get(`/api/agents/trpc/own.sharedWithMe?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(shared.status, JSON.stringify(shared.body).slice(0, 300)).toBe(200);
  expect(shared.body.result.data).toEqual([{ id: agent.id, ownerId, name: OWN_AGENT, version: agent.version, state: agent.state }]);

  // Deletes the spare draft: it asks for an irreversible confirmation first, and nothing is deleted until it is given.
  const spareRow = (await ownAgents()).filter((row) => row.name === SPARE);
  expect(spareRow).toHaveLength(1);
  const spareId = spareRow[0].id;
  const unconfirmed = await (await api(agents.account())).post('/api/agents/trpc/own.delete', { id: spareId, confirm: '' });
  expect(unconfirmed.status).toBe(400);
  expect(unconfirmed.body.error.message).toBe('agents.own.delete_unconfirmed');
  expect((await ownAgents()).map((row) => row.id)).toContain(spareId);
  await openAgents(page, agents);
  const spare = main(page).getByRole('row').filter({ hasText: SPARE });
  await spare.getByRole('button', { name: 'Delete draft' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this draft?' });
  await expect(confirm).toContainText(`“${SPARE}” is deleted for good, with its settings. This cannot be undone.`);
  expect((await ownAgents()).map((row) => row.id)).toContain(spareId);
  await confirm.getByRole('button', { name: 'Delete for good' }).click();
  await expect(confirm).toBeHidden();
  await expect(spare).toHaveCount(0);
  await expect(main(page).getByText('Draft deleted.')).toBeVisible();
  await expect(main(page).getByRole('link', { name: OWN_AGENT, exact: true })).toBeVisible();
  // Gone for good in svc-agents; the agent it was spare to is kept.
  expect((await ownAgents()).map((row) => row.id)).not.toContain(spareId);
  const gone = await (
    await api(agents.account())
  ).get(`/api/agents/trpc/own.get?input=${encodeURIComponent(JSON.stringify({ id: spareId }))}`);
  expect(gone.status).toBe(404);
  expect(gone.body.error.message).toBe('agents.own.not_found');
  expect((await ownAgent()).id).toBe(agent.id);
});
