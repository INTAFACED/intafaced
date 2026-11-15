// World: none
import { test, expect } from './journey.mjs';
import { journeyState, signOutBrowser } from './stack.mjs';
import { signIn, signUp } from './desk.mjs';

// J-charts-desk-13, in the running app (docs/roadmap/journeys.json): a signed-in person reads market news on /trade/news
// and the economic calendar on /trade/calendar, filters both, and opens a symbol's news widget on the chart. No news data
// vendor is connected (feed.news), so every vendor read ends in the named notice with its code, while the layout and the
// filters work on what the store holds: nothing. One test per step, titled "J-charts-desk-13 #<n>", run in order on one
// TEST account (the run file keeps it).
const J = 'J-charts-desk-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const NEWS_NOTICE = 'News needs a news data feed. It is switched off in this build.';
const CALENDAR_NOTICE = 'The calendar needs a news data feed. It is switched off in this build.';
const EMPTY = 'The store holds no items, so there is nothing to list.';

function account() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** The notice the vendor read ends in: the sentence and the allowlist code, in one status. */
async function expectNotice(page, sentence) {
  const notice = page.getByRole('status').filter({ hasText: sentence });
  await expect(notice).toHaveCount(1);
  await expect(notice.locator('code')).toHaveText('feed.news');
}

const newsFilters = (page) => page.getByRole('form', { name: 'News' });
const calendarFilters = (page) => page.getByRole('form', { name: 'Economic calendar' });

test(`${J} #1 opens news: the feed.news notice with its code, and the filters still render`, async ({ page }) => {
  const who = await signUp(page, 'nws');
  run.reset({ account: who });
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/trade/news');
  await expect(page.getByRole('heading', { level: 1, name: 'News' })).toBeVisible();
  await expectNotice(page, NEWS_NOTICE);
  // The filters render and are usable, not greyed out behind the notice.
  const form = newsFilters(page);
  for (const name of ['Category', 'Language']) await expect(form.getByRole('combobox', { name })).toBeEnabled();
  await expect(form.getByRole('textbox', { name: 'Symbol' })).toBeEditable();
  await expect(page.getByText(EMPTY)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/coming soon/i);
});

test(`${J} #2 filters by category and language: the filters apply to what the store holds, and empty reads as empty`, async ({ page }) => {
  await signIn(page, account());
  await page.goto('/trade/news');
  const form = newsFilters(page);
  const category = form.getByRole('combobox', { name: 'Category' });
  const language = form.getByRole('combobox', { name: 'Language' });
  // The filters offer their own choices even with an empty store, so a person can filter at all.
  await expect(category.locator('option')).toHaveText(['All categories', 'Markets', 'Crypto', 'Macro', 'Company', 'Regulation']);
  await expect(language.locator('option')).toHaveText(['All languages', 'English', 'Spanish', 'French']);
  await category.selectOption({ label: 'Crypto' });
  await language.selectOption({ label: 'English' });
  await expect(category).toHaveValue('crypto');
  await expect(language).toHaveValue('en');
  // The filters are applied: the clear control appears, and the store's answer (nothing) reads as empty, never as a sample.
  const clear = form.getByRole('button', { name: 'Clear filters' });
  await expect(clear).toBeVisible();
  await expect(page.getByText(EMPTY)).toBeVisible();
  await expect(page.locator('.news-list li')).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Symbol' }).fill('btc');
  await expect(form.getByRole('textbox', { name: 'Symbol' })).toHaveValue('BTC');
  await expect(page.getByText(EMPTY)).toBeVisible();
  await clear.click();
  await expect(category).toHaveValue('');
  await expect(language).toHaveValue('');
  await expect(clear).toHaveCount(0);
  await expectNotice(page, NEWS_NOTICE);
});

test(`${J} #3 opens the economic calendar and highlights events: the layout with highlighting and filters, and the notice on the vendor fetch`, async ({
  page,
}) => {
  await signIn(page, account());
  await page.goto('/trade/news');
  await page.getByRole('link', { name: 'Open the economic calendar' }).click();
  await expect(page).toHaveURL(/\/trade\/calendar$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Economic calendar' })).toBeVisible();
  await expectNotice(page, CALENDAR_NOTICE);
  const form = calendarFilters(page);
  const highlight = form.getByRole('checkbox', { name: 'Colour actual against forecast' });
  await expect(highlight).toBeChecked();
  await highlight.uncheck();
  await expect(highlight).not.toBeChecked();
  await highlight.check();
  await expect(highlight).toBeChecked();
  const priority = form.getByRole('combobox', { name: 'Priority' });
  await expect(priority.locator('option')).toHaveText(['All priorities', 'Low', 'Medium', 'High']);
  await priority.selectOption({ label: 'High' });
  await expect(priority).toHaveValue('high');
  await expect(form.getByRole('combobox', { name: 'Country' })).toBeEnabled();
  // The store holds no events, so the filtered calendar reads empty, with no table of made-up releases.
  await expect(page.getByText(EMPTY)).toBeVisible();
  await expect(page.locator('.news-table')).toHaveCount(0);
});

test(`${J} #4 opens a symbol's news widget on the chart: the widget with the same notice`, async ({ page }) => {
  await signIn(page, account());
  await page.goto('/charts/BTC-USDT');
  await expect(page.getByTestId('cw').first()).toBeVisible();
  const open = page.getByRole('button', { name: 'News', exact: true });
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  const widget = page.getByRole('region', { name: 'News for BTC-USDT' });
  await expect(widget).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide news' })).toHaveAttribute('aria-expanded', 'true');
  // The same notice as the News room, with its code, inside the widget.
  const notice = widget.getByRole('status');
  await expect(notice).toContainText(NEWS_NOTICE);
  await expect(notice.locator('code')).toHaveText('feed.news');
  await expect(widget).toContainText('The store holds no items for BTC-USDT, so there is nothing to list.');
  await widget.getByRole('link', { name: 'Open news for every market' }).click();
  await expect(page).toHaveURL(/\/trade\/news$/);
  await expectNotice(page, NEWS_NOTICE);
});
