import { test, expect } from '@playwright/test';
import { OWN_AGENT, UNBUILT, agentsRun, openAgents, openOwnAgent } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-03, in the running app (docs/roadmap/journeys.json): create my own agent from a template, protect it and
// publish it. One test per step, titled "J-agents-03 #<n>", run in order on one verified TEST account, starting on
// /agents/new. Creating an agent moves no money. The assistant-drafting panel waits on the owner's model choice
// (owner.decision) while the rest of the builder works.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /agents/new answers "Page not found": there is no template picker, builder, validator, protection check, identity
//   page or publish flow (AG-catalogue-02, AG-builder-01, -03, AG-identity-01, AG-spend-01, AG-tools-01).
// Not covered yet: #5's frozen-owner clause (freezing this run's account would stop #6 to #8) and its blank-lifetime
// clause (it depends on the owner value the stack publishes); both join #5 with the identity page.
const J = 'J-agents-03';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const builder = (page) => main(page).getByRole('form', { name: 'Agent builder' });
const check = (page) => main(page).getByRole('region', { name: 'Protection check' });

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
  const picker = main(page).getByRole('region', { name: 'Templates' });
  await picker.getByRole('button', { name: 'Use the service starter' }).click();
  await expect(builder(page).getByRole('textbox', { name: /^Spend cap per session/ })).toHaveValue('');
  await expect(builder(page).getByRole('list', { name: 'Tools' }).getByRole('listitem').first()).toBeVisible();
  const first = await builder(page).getByTestId('draft-id').innerText();
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill(OWN_AGENT);
  await builder(page).getByRole('button', { name: 'Save draft' }).click();

  await page.goto('/agents/new');
  await picker.getByRole('button', { name: 'Use the service starter' }).click();
  const second = await builder(page).getByTestId('draft-id').innerText();
  expect(second).not.toBe(first);
});

test(`${J} #2 edits the name, instructions and tools, adds a tool that moves money: the validator refuses it with its reason; "sessions" is reserved`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Build');
  await builder(page)
    .getByRole('textbox', { name: /^Instructions/ })
    .fill('Answer TEST questions about my orders.');
  await builder(page).getByRole('button', { name: 'Add a tool' }).click();
  await page
    .getByRole('dialog', { name: 'Add a tool' })
    .getByRole('option', { name: /ledger\.transfer/ })
    .click();
  await expect(builder(page).getByRole('alert')).toContainText('A tool that moves money cannot be added to an agent.');
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill('sessions');
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(builder(page).getByRole('alert')).toContainText('“sessions” is a reserved name.');
  await builder(page).getByRole('textbox', { name: /^Name/ }).fill(OWN_AGENT);
});

test(`${J} #3 reads the protection check: a blocking finding for the missing per-session cap`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Build');
  await expect(check(page).getByRole('listitem').filter({ hasText: 'No spend cap per session' })).toContainText('Blocks publishing');
});

test(`${J} #4 sets the cap and tool shapes: the finding clears; publish otherwise refuses with the unset-cap code`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Build');
  await main(page).getByRole('button', { name: 'Publish' }).click(UNBUILT);
  await expect(main(page).getByRole('alert')).toContainText('agents.spend.cap_unset');
  await builder(page)
    .getByRole('textbox', { name: /^Spend cap per session/ })
    .fill('1');
  await builder(page).getByRole('button', { name: 'Save draft' }).click();
  await expect(check(page).getByRole('listitem').filter({ hasText: 'No spend cap per session' })).toHaveCount(0);
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
  const assistant = main(page).getByRole('region', { name: 'Draft with the assistant' });
  await expect(assistant.getByRole('note')).toContainText('owner.decision');
  await expect(assistant.getByRole('button', { name: 'Draft it' })).toBeDisabled();
  // The rest of the builder still works without it.
  await main(page).getByRole('region', { name: 'Templates' }).getByRole('button', { name: 'Start blank' }).click();
  await expect(builder(page).getByRole('textbox', { name: /^Name/ })).toBeEditable();
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
  const spare = main(page).getByRole('row').filter({ hasText: 'Draft' }).first();
  await spare.getByRole('button', { name: 'Delete draft' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this draft?' });
  await expect(confirm).toContainText('This cannot be undone.');
  await confirm.getByRole('button', { name: 'Delete for good' }).click();
});
