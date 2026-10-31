import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, openAgents, openOwnAgent } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api, tool } from './stack.mjs';

// J-agents-03, in the running app (docs/roadmap/journeys.json): create my own agent from a template, protect it and
// publish it. One test per step, titled "J-agents-03 #<n>", run in order on one verified TEST account, starting on
// /agents/new. Creating an agent moves no money. The assistant-drafting panel waits on the owner's model choice
// (owner.decision) while the rest of the builder works. The draft each step leaves is read back from svc-agents
// (own.* through Edge), not only from the page.
// A clause the product cannot run yet stays red in a test of its own, named by that clause:
// - #6 "once set a draft appears ...": the assistant waits on the owner's choice of model (owner.decision).
// The identity page, publishing to a surface and sharing are not built either (AG-identity-01, AG-builder-03), so #5, #7 and #8 fail
// at their first missing part, quickly (UNBUILT).
// Not covered yet: #5's frozen-owner clause (freezing this run's account would stop #6 to #8) and its blank-lifetime
// clause (it depends on the owner value the stack publishes); both join #5 with the identity page.
const J = 'J-agents-03';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const SPARE = 'TEST spare draft';
const RENAMED = 'TEST renamed agent';
const DESCRIPTION = 'TEST: answer questions about my orders and never move money.';
/** The fields own.save takes, as svc-agents holds them. */
const pick = ({ id, name, instructions, tools, perSessionCap }) => ({ id, name, instructions, tools, perSessionCap });

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

test(`${J} #5 opens the identity page: owner, scopes and expiry of the agent's own token; a revoke fails the next call; a frozen owner fails it too`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Identity');
  const identity = main(page).getByRole('region', { name: 'Agent identity' });
  for (const term of ['Owner', 'Scopes', 'Expires']) await expect(identity.getByRole('term').filter({ hasText: term })).toBeVisible();
  await identity.getByRole('button', { name: 'Revoke token' }).click();
  await expect(identity.getByRole('status')).toContainText('Revoked. The agent’s next call will fail.');
});

test(`${J} #6 asks the assistant to draft an agent: with the model unset the owner-decision notice and the builder still works; nothing saved until accepted`, async ({
  page,
}) => {
  await openBuilder(page);
  const before = await ownAgents();
  const assistant = main(page).getByRole('region', { name: 'Draft with the assistant' });
  const description = assistant.getByRole('textbox', { name: 'Describe the agent in plain words' });
  await description.fill(DESCRIPTION);
  await expect(description).toHaveValue(DESCRIPTION);
  await expect(assistant.getByRole('note').locator('code')).toHaveText('owner.decision');
  await expect(assistant.getByRole('button', { name: 'Draft it' })).toBeDisabled();
  // The panel drafted and saved nothing.
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
});

test(`${J} #6 once the model choice is set a draft appears whose tools passed the validator; nothing is saved until accepted`, async ({
  page,
}) => {
  // The assistant waits on the owner's choice of model (owner.decision): red, by name, until the owner makes it. No
  // model setting exists yet to set here; when it lands, this test sets it and restores it blank in a try/finally.
  await openBuilder(page);
  const before = await ownAgents();
  const { tools: catalogue } = await ownRead('catalogue');
  const assistant = main(page).getByRole('region', { name: 'Draft with the assistant' });
  await assistant.getByRole('textbox', { name: 'Describe the agent in plain words' }).fill(DESCRIPTION);
  await expect(assistant.getByRole('button', { name: 'Draft it' })).toBeEnabled(UNBUILT);
  await assistant.getByRole('button', { name: 'Draft it' }).click();
  // A draft appears; each of its tools is one the validator admits: in the catalogue, and none moves money.
  const proposedTools = assistant.getByRole('list', { name: 'Tools' }).getByRole('listitem').locator('code');
  await expect(proposedTools.first()).toBeVisible();
  const proposed = await proposedTools.allInnerTexts();
  expect(proposed.length).toBeGreaterThan(0);
  for (const name of proposed) expect(catalogue.find((tool) => tool.name === name)).toMatchObject({ movesMoney: false });
  // Nothing is saved until it is accepted.
  expect(await ownAgents()).toEqual(before);
  await assistant.getByRole('button', { name: 'Accept' }).click();
  const after = await ownAgents();
  expect(after).toHaveLength(before.length + 1);
  expect(after[0]).toMatchObject({ tools: proposed, state: 'draft' });
  // svc-agents' own validator held it: read back, the accepted draft carries exactly those tools and no money tool.
  const accepted = await ownRead('get', { id: after[0].id });
  expect(accepted.tools).toEqual(proposed);
  expect(accepted.tools.filter((name) => catalogue.find((tool) => tool.name === name)?.movesMoney !== false)).toEqual([]);
});

test(`${J} #7 publishes to a chosen surface, then edits and republishes: version 1 immutable; the edit is a draft; running sessions keep their version`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Build');
  await main(page).getByRole('button', { name: 'Publish' }).click(UNBUILT);
  const publish = page.getByRole('dialog', { name: 'Publish' });
  await publish.getByRole('checkbox', { name: 'My agents' }).check();
  await publish.getByRole('button', { name: 'Publish version 1' }).click();
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 1 · published');
  await builder(page)
    .getByRole('textbox', { name: /^Instructions/ })
    .fill('Answer TEST questions, briefly.');
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(main(page).getByTestId('agent-version')).toHaveText('Version 2 · draft');
  await main(page).getByRole('button', { name: 'Publish' }).click();
  // A surface the policy forbids for a personal agent is offered but blocked, with the reason.
  await expect(publish.getByRole('checkbox', { name: 'Public catalogue' })).toBeDisabled();
  await expect(publish).toContainText('Not allowed for this agent:');
});

test(`${J} #8 shares the agent with a co-owner and deletes a spare draft: a group as co-owner is refused; deletion asks for an irreversible confirmation`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Sharing');
  const share = main(page).getByRole('form', { name: 'Co-owners' });
  await share.getByRole('textbox', { name: /^Add a co-owner/ }).fill('group:TEST-team');
  await share.getByRole('button', { name: 'Add' }).click();
  await expect(share.getByRole('alert')).toContainText('A group cannot be a co-owner.');

  await openAgents(page, agents);
  const spare = main(page).getByRole('row').filter({ hasText: SPARE });
  await spare.getByRole('button', { name: 'Delete draft' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this draft?' });
  await expect(confirm).toContainText('This cannot be undone.');
  await confirm.getByRole('button', { name: 'Delete for good' }).click();
  await expect(spare).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: OWN_AGENT, exact: true })).toBeVisible();
});
