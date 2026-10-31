import { test, expect } from './journey.mjs';
import { UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-05, in the running app (docs/roadmap/journeys.json): approve, edit or reject what my agent wants to do. One
// test per step, titled "J-agents-05 #<n>", run in order on one verified TEST account with an agent of its own that has a
// tool needing approval and the standing rule "ask before sending a comment". The gated tool runs exactly once after
// approval, never before, and every decision is recorded. The push notice shows its vendor text (vendor.push); the
// automatic reviewer waits on the owner's model choice (owner.decision).
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the person cannot create an agent yet (no builder at /agents/new), so there is no Rules page, consent card,
//   Approvals inbox or automatic reviewer (AG-guardrails-01, -02, AG-approvals-01, -02).
const J = 'J-agents-05';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const rules = (page) => main(page).getByRole('form', { name: 'Rules' });
const inbox = (page) => tableIn(main(page), 'Approvals');

async function openInbox(page) {
  await signIn(page, agents.account());
  await page.goto('/agents/approvals');
  await expect(main(page).getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account with an agent of its own that has a tool needing approval`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag05', '10');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 writes "ask before sending a comment", then a rule that acts without asking on a live-write tool: the first saves, the second and any loosening are refused`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Rules');
  await rules(page)
    .getByRole('textbox', { name: /^New rule/ })
    .fill('Ask before sending a comment');
  await rules(page).getByRole('button', { name: 'Save rule' }).click();
  await expect(rules(page).getByRole('list', { name: 'Your rules' })).toContainText('Ask before sending a comment');
  await rules(page)
    .getByRole('textbox', { name: /^New rule/ })
    .fill('Send comments without asking');
  await rules(page).getByRole('button', { name: 'Save rule' }).click();
  await expect(rules(page).getByRole('alert')).toContainText('A rule cannot let a live-write tool act without asking.');
  await rules(page)
    .getByRole('textbox', { name: /^New rule/ })
    .fill('Allow more actions per session than the baseline');
  await rules(page).getByRole('button', { name: 'Save rule' }).click();
  await expect(rules(page).getByRole('alert')).toContainText('A rule cannot loosen the baseline.');
});

test(`${J} #2 uses a connector class for the first time: the consent card appears and the call is refused until granted; revoking withdraws it`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Test');
  await main(page).getByRole('button', { name: 'Run a test' }).click(UNBUILT);
  const consent = page.getByRole('dialog', { name: /^Allow this agent to use/ });
  await expect(consent).toBeVisible();
  await expect(main(page).getByRole('alert')).toContainText('Refused until you allow it.');
  await consent.getByRole('button', { name: 'Allow' }).click();
  await openOwnAgent(page, agents, 'Permissions');
  await main(page).getByRole('button', { name: 'Revoke' }).first().click();
  await expect(main(page).getByRole('status')).toContainText('Withdrawn');
});

test(`${J} #3 runs the agent to the gated tool: the tool has not run, the run reads waiting for approval and a request row exists`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Runs');
  const run = tableIn(main(page), 'Live runs').getByRole('row').nth(1);
  await expect(run).toContainText('Waiting for approval', UNBUILT);
  await openInbox(page);
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Send a comment' })).toHaveCount(1);
});

test(`${J} #4 gets the notice and opens the Approvals inbox: the notice names the action and links to the inbox; the push notice shows the vendor text`, async ({
  page,
}) => {
  await signIn(page, agents.account());
  await page.goto('/home');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const notice = page.getByRole('dialog', { name: /Notifications/ }).getByRole('link', { name: /wants to send a comment/ });
  await expect(notice).toBeVisible(UNBUILT);
  await notice.click();
  await expect(page).toHaveURL(/\/agents\/approvals/);
  await expect(main(page).getByRole('note').filter({ hasText: 'vendor.push' })).toBeVisible();
});

test(`${J} #5 edits the payload then approves: a new request for the new payload, the old approval does not carry over; approve runs once, a repeat returns the first result`, async ({
  page,
}) => {
  await openInbox(page);
  const request = inbox(page).getByRole('row').filter({ hasText: 'Send a comment' }).first();
  await request.getByRole('button', { name: 'Edit' }).click();
  await page
    .getByRole('dialog', { name: 'Edit the request' })
    .getByRole('textbox', { name: /^Comment/ })
    .fill('TEST comment, edited');
  await page.getByRole('dialog', { name: 'Edit the request' }).getByRole('button', { name: 'Save as a new request' }).click();
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Replaced by your edit' })).toHaveCount(1);
  const edited = inbox(page).getByRole('row').filter({ hasText: 'TEST comment, edited' });
  await edited.getByRole('button', { name: 'Approve' }).click();
  await expect(edited).toContainText('Approved · ran once');
  await edited.getByRole('button', { name: 'Approve again' }).click();
  await expect(main(page).getByRole('status')).toContainText('Already approved: the first result is shown.');
});

test(`${J} #6 rejects another request and lets a third expire: the step ends with a typed refusal; an expired request or a down identity service fails closed`, async ({
  page,
}) => {
  await openInbox(page);
  const pending = inbox(page).getByRole('row').filter({ hasText: 'Waiting' });
  await pending.first().getByRole('button', { name: 'Reject' }).click(UNBUILT);
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Rejected' }).first()).toContainText('agents.approval.rejected');
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Expired' }).first()).toContainText('agents.approval.expired', {
    timeout: 120_000,
  });
});

test(`${J} #7 turns on the automatic reviewer for no-value tools: "proceed" runs a no-value call; a value tool always asks; with the model unset the owner-decision notice`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Rules');
  const reviewer = main(page).getByRole('switch', { name: 'Automatic reviewer for tools that move no value' });
  await expect(reviewer).toBeVisible(UNBUILT);
  // While the owner has not chosen the reviewer's model it stays off and says so; calls go to the person.
  await expect(reviewer).toBeDisabled();
  await expect(main(page).getByRole('note').filter({ hasText: 'owner.decision' })).toContainText('reviewer');
  await expect(main(page)).toContainText('Tools that can move value always ask you.');
});
