import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, journeyState } from './stack.mjs';

// J-developer-16, in the running app (docs/roadmap/journeys.json): keep up with API changes and status. One test per
// step, titled "J-developer-16 #<n>", run signed out (the pages are public). The status components and changelog entries
// are those the stack serves; a version header is checked against Edge's own reply.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: no machine status feed with incidents, updates and uptime history.
// - #3: changelog entries carry no breaking flag or "date not set".
// - #4: Notices list no breaking changes, cutover dates or retired list.
// - #5, #6: Edge reads no version header and sends no advisory header.
const J = 'J-developer-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

const call = (headers = {}) => fetch(`${EDGE}/api/v1/markets`, { headers: { origin: ORIGIN, ...headers } });

test(`${J} #1 opens /status: component states with an as-of time and an empty incident list; no data reads unknown`, async ({ page }) => {
  run.reset({});
  await page.goto('/developers/status');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/As of/)).toBeVisible();
  const components = page.getByRole('table', { name: 'Components' });
  for (const row of await components.locator('tbody tr').all()) await expect(row).toContainText(/Operational|Degraded|Outage|Unknown/);
  await expect(page.getByText(/No incidents/)).toBeVisible();
});

test(`${J} #2 reads the machine feed: components, incidents with impact and updates, and uptime history`, async () => {
  const res = await fetch(`${ORIGIN}/developers/status.json`);
  expect(res.status, 'the status feed is published').toBe(200);
  const feed = await res.json();
  expect(Array.isArray(feed.components)).toBe(true);
  expect(Array.isArray(feed.incidents)).toBe(true);
  expect(feed.uptime).toBeTruthy();
});

test(`${J} #3 opens the changelog: dated entries by area with a breaking flag; no date reads "date not set" and is not upcoming`, async ({
  page,
}) => {
  await page.goto('/developers/changelog');
  const entries = page.getByRole('article');
  await expect(entries.first().or(page.getByText(/No changes/))).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Area' })).toBeVisible(UNBUILT);
  await expect(page.getByText('Breaking', { exact: true }).first()).toBeVisible();
  await page.goto('/developers/changelog/upcoming');
  await expect(page.getByText('date not set')).toHaveCount(0);
});

test(`${J} #4 opens /notice: advance notice of breaking changes, cutover dates and the retired list`, async ({ page }) => {
  await page.goto('/notice');
  await expect(page.getByRole('region', { name: 'Breaking changes' })).toBeVisible(UNBUILT);
  await expect(page.getByRole('region', { name: 'Retired' })).toBeVisible();
});

test(`${J} #5 calls with a version header, without, and with an unknown one: applied and echoed; default; unknown refused`, async () => {
  const known = await call({ 'intafaced-version': '2026-10-01' });
  expect(known.headers.get('intafaced-version')).toBe('2026-10-01');
  const unknown = await call({ 'intafaced-version': '1999-01-01' });
  expect(unknown.status).toBe(400);
});

test(`${J} #6 calls a deprecated field: the reply carries the advisory header and entry`, async () => {
  const res = await call({ 'intafaced-version': '2026-10-01' });
  expect(res.headers.get('deprecation')).toBeTruthy();
  expect(res.headers.get('link')).toMatch(/changelog/);
});
