import { expect } from '@playwright/test';
import { fundedTrader, signIn } from './desk.mjs';
import { journeyState } from './stack.mjs';

// Shared parts of the agents journeys (J-agents-NN) written ahead of their rooms. The Agents room is /agents (More),
// with its sections as buttons in the "Agent sections" group; on the stack svc-agents runs with its five session agents
// and published routing prices, and opening a session needs the agents:execute scope, which a standard TEST account does
// not hold. A step whose room or control is not built fails at its first missing part within UNBUILT.
// A table is found the way the app's DataTable draws one: a region named by the table's label, holding the table.

/** The wait for a part a step needs that may not be built yet: short, so an unbuilt step fails fast and says where. */
export const UNBUILT = { timeout: 5_000 };

/** One journey run's state: the TEST account its first step made. */
export function agentsRun(journey) {
  const run = journeyState(`${journey}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
  return {
    run,
    /** The journey's start: a verified TEST account funded with `usdt` TEST USDT, kept for every later step. */
    async start(page, prefix, usdt = '100') {
      const who = await fundedTrader(page, prefix, usdt);
      run.reset({ account: who });
      return who;
    },
    /** The run's account; a step after a failed start says so instead of acting as no one. */
    account() {
      const { account } = run.read();
      if (!account) throw new Error(`${journey} made no account, so this step has no one to act as`);
      return account;
    },
  };
}

/** Signs the run's account in and opens /agents, on `section` when one is named. */
export async function openAgents(page, agents, section) {
  await signIn(page, agents.account());
  await page.goto('/agents');
  await expect(page.getByRole('main').getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible();
  if (section) await agentSection(page, section);
}

/** Opens one section of the Agents room by its button in "Agent sections". */
export async function agentSection(page, name) {
  await page.getByRole('group', { name: 'Agent sections' }).getByRole('button', { name, exact: true }).click(UNBUILT);
}

/** A catalogue card by the agent's name. */
export const agentCard = (page, name) =>
  page
    .getByRole('main')
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

/** A table drawn by the app's DataTable: the region named `name`, holding the table. */
export const tableIn = (scope, name) => scope.getByRole('region', { name, exact: true }).getByRole('table');

/** The TEST agent of the person's own that the journeys create from the service starter template (J-agents-03 #1). */
export const OWN_AGENT = 'TEST helper';

/**
 * Creates the person's own agent from the template picker on /agents/new (the builder, J-agents-03) with a per-session
 * cap, so a journey that starts from "an agent of the person's own" has one. Fails at the builder while it is unbuilt.
 */
export async function createOwnAgent(page, { cap = '1' } = {}) {
  await page.goto('/agents/new');
  const picker = page.getByRole('region', { name: 'Templates' });
  await picker.getByRole('button', { name: 'Use the service starter' }).click(UNBUILT);
  const builder = page.getByRole('form', { name: 'Agent builder' });
  await builder.getByRole('textbox', { name: /^Name/ }).fill(OWN_AGENT);
  await builder.getByRole('textbox', { name: /^Spend cap per session/ }).fill(cap);
  await builder.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status')).toContainText('Draft saved');
}

/** Opens one page of the person's own agent (Limits, Rules, Test, Memory, ...) from My agents. Its pages are the app's
 * Tabs, a group of buttons named "Agent pages", as the room's own sections are. */
export async function openOwnAgent(page, agents, tab) {
  await openAgents(page, agents);
  await page.getByRole('main').getByRole('link', { name: OWN_AGENT, exact: true }).click(UNBUILT);
  await expect(page.getByRole('main').getByRole('heading', { name: OWN_AGENT, level: 1 })).toBeVisible();
  if (tab) await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: tab, exact: true }).click(UNBUILT);
}

/** Opens a Navigator session from the catalogue through its review sheet; returns the session id the workspace shows. */
export async function openNavigatorSession(page, agents) {
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Open a session' }).click();
  await page.getByRole('main').getByRole('button', { name: 'Review session' }).click();
  await page.getByRole('dialog', { name: 'Review agent session' }).getByRole('button', { name: 'Open agent session' }).click();
  await expect(page.getByText('Agent session opened')).toBeVisible(UNBUILT);
  return page.getByRole('main').getByRole('region', { name: 'Session workspace' }).getByTestId('session-id').innerText();
}
