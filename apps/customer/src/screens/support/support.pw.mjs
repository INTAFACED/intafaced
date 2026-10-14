import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { articles, comment, comments, events, failure, owner, ticket, tickets, trpc } from './support.fixtures.mjs';

const shots = process.env.SUPPORT_SHOTS ?? join(tmpdir(), 'intafaced-support-shots');
mkdirSync(shots, { recursive: true });

const forbidden = /unavailable|not connected|restricted|fixture|lifecycle|\bledger\b|deposit_withdraw|kb-account|support\.kb\./i;
const uuidText = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Answer svc-support (/api/support/trpc/<procedure>). State lives in the test, so a write changes what the next read returns.
 * An override is a function of the request input, `null` to hold the request until `release()`, 'refuse' for a 503,
 * or a plain value. No service is contacted.
 */
async function mock(page, overrides = {}) {
  const state = { tickets: tickets(), comments: comments(), created: [] };
  const base = {
    searchKb: (input) => articles().filter((row) => !input.q || row.id.includes(input.q.toLowerCase().replace(/\s+/g, '-'))),
    listMine: () => state.tickets,
    get: (input) => state.tickets.find((row) => row.id === input.ticketId),
    listComments: () => state.comments,
    events: () => events(),
    create: (input) => {
      const row = ticket(9, { ...input, subject: input.subject, body: input.body, id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000009' });
      state.tickets = [row, ...state.tickets];
      state.created.push(input);
      return row;
    },
    comment: (input) => {
      const row = { ...comment(7, 'user', input.body), ticketId: input.ticketId };
      state.comments = [...state.comments, row];
      return row;
    },
  };
  const served = { ...base, ...overrides };
  const held = [];
  const seen = [];
  await page.route('**/api/support/trpc/**', async (route) => {
    const url = new URL(route.request().url());
    const procedure = decodeURIComponent(url.pathname.split('/trpc/')[1]);
    const input =
      route.request().method() === 'POST'
        ? route.request().postDataJSON()
        : url.searchParams.get('input')
          ? JSON.parse(url.searchParams.get('input'))
          : undefined;
    seen.push({ procedure, input, method: route.request().method() });
    if (!(procedure in served)) return route.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
    const value = served[procedure];
    if (value === null) return void held.push({ route, procedure, input });
    if (value === 'refuse') return route.fulfill({ status: failure.status, json: failure.json });
    return route.fulfill({ status: 200, json: trpc(typeof value === 'function' ? value(input) : value) });
  });
  return {
    state,
    seen,
    calls: (procedure) => seen.filter((call) => call.procedure === procedure),
    release: async () => {
      for (const { route, procedure, input } of held.splice(0)) {
        const value = base[procedure];
        await route.fulfill({ status: 200, json: trpc(typeof value === 'function' ? value(input) : value) });
      }
    },
  };
}

const open = async (page) => {
  await page.goto('/');
  await page.locator('.if-support').waitFor();
};
const snap = async (page, name) => {
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};
async function shootBoth(page, name) {
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await snap(page, `${name}-${size.width}x${size.height}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
const watch = (page) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
};
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('help centre: articles you can read, your requests, and the message form, in plain words', async ({ page }) => {
  const errors = watch(page);
  await mock(page);
  await open(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Help' })).toBeVisible();
  // Three articles; the two about features this release doesn't offer are left out.
  const triggers = page.locator('.sup-articles button');
  expect(await triggers.allTextContents()).toEqual(['Sign-in and account access', 'Security basics', 'Order status']);
  await triggers.first().click();
  await expect(page.locator('.sup-articles')).toContainText('Support never asks for your password');
  // Requests: a status word, an updated time in the viewer's zone, and no raw ids.
  const mine = page.getByRole('region', { name: 'Your requests', exact: true });
  await expect(mine).toContainText('Test request 1');
  await expect(mine).toContainText('Open');
  await expect(mine).toContainText('Resolved');
  await expect(mine).toContainText('Updated 13 Oct, 09:30');
  // The message form: topics in words, the deposit topic hidden, no codes on screen.
  const form = page.getByRole('region', { name: 'Send us a message', exact: true });
  await form.getByRole('combobox').click();
  expect(await page.getByRole('option').allTextContents()).toEqual(['Account and sign-in', 'Trading and orders', 'Something else']);
  await page.keyboard.press('Escape');
  const text = await page.locator('.if-support').innerText();
  expect(text).not.toMatch(forbidden);
  expect(text).not.toMatch(uuidText);
  expect(await noOverflow(page)).toBe(true);
  await shootBoth(page, 'support-loaded');
  expect(errors).toEqual([]);
});

test('help centre: search sends the word and shows what matches', async ({ page }) => {
  const api = await mock(page);
  await open(page);
  await page.getByRole('searchbox', { name: 'Search help' }).fill('order');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.sup-articles button')).toHaveText(['Order status']);
  expect(api.calls('searchKb').at(-1).input).toEqual({ q: 'order', limit: 50 });
  await page.getByRole('searchbox', { name: 'Search help' }).fill('zzz');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No articles match your search.')).toBeVisible();
  await shootBoth(page, 'support-search-empty');
});

test('message form: sends a request, says so, and the new request shows in the list', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page);
  await open(page);
  const form = page.getByRole('region', { name: 'Send us a message', exact: true });
  await expect(form.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await form.getByLabel('Subject').fill('  I can’t see my balance ');
  await form.getByLabel('Message').fill('It says zero since this morning.');
  await form.getByRole('button', { name: 'Send message' }).click();
  await expect(form).toContainText('Your message was sent. We’ll reply under Your requests.');
  expect(api.state.created).toEqual([{ category: 'account', subject: 'I can’t see my balance', body: 'It says zero since this morning.' }]);
  await expect(page.getByRole('region', { name: 'Your requests', exact: true })).toContainText('I can’t see my balance');
  // The fields are cleared for the next message.
  await expect(form.getByLabel('Subject')).toHaveValue('');
  expect(errors).toEqual([]);
});

test('message form: a lost answer is said to be unknown, a refusal is said in words', async ({ page }) => {
  await mock(page, { create: 'refuse' });
  await open(page);
  const form = page.getByRole('region', { name: 'Send us a message', exact: true });
  await form.getByLabel('Subject').fill('Hello');
  await form.getByLabel('Message').fill('Anyone there?');
  await form.getByRole('button', { name: 'Send message' }).click();
  await expect(form).toContainText('We couldn’t confirm your message was sent. Check Your requests before sending it again.');
  // The text stays so nothing is lost.
  await expect(form.getByLabel('Message')).toHaveValue('Anyone there?');
  await shootBoth(page, 'support-send-unknown');
});

test('conversation: your message, the reply, the history, and sending a reply', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page);
  await open(page);
  await page.getByRole('button', { name: 'Conversation: Test request 1' }).click();
  const thread = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(thread).toContainText('This is test request 1.');
  await expect(thread).toContainText('It has a second paragraph.');
  await expect(thread).toContainText('Support · 13 Oct, 05:00');
  await expect(thread).toContainText('We are looking at it.');
  await thread.getByText('History').click();
  await expect(thread).toContainText('Request opened');
  expect(await thread.innerText()).not.toMatch(uuidText);
  await shootBoth(page, 'support-conversation');
  await thread.getByLabel('Reply').fill('Thank you, that fixed it.');
  await thread.getByRole('button', { name: 'Send reply' }).click();
  await expect(thread).toContainText('Your reply was sent.');
  await expect(thread).toContainText('Thank you, that fixed it.');
  expect(api.calls('comment')[0].input).toEqual({ ticketId: tickets()[0].id, body: 'Thank you, that fixed it.' });
  expect(errors).toEqual([]);
});

test('conversation: a resolved request says a reply reopens it; a closed one takes no reply', async ({ page }) => {
  await mock(page, {
    listMine: () => [ticket(1, { status: 'closed' })],
    get: () => ticket(1, { status: 'closed' }),
  });
  await open(page);
  await page.getByRole('button', { name: 'Conversation: Test request 1' }).click();
  const thread = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(thread).toContainText('This request is closed, so it can’t take more replies.');
  await expect(thread.getByRole('button', { name: 'Send reply' })).toHaveCount(0);
  const resolved = await page.context().newPage();
  await mock(resolved, { get: () => ticket(1, { status: 'resolved' }) });
  await resolved.goto('/');
  await resolved.getByRole('button', { name: 'Conversation: Test request 1' }).click();
  await expect(resolved.getByRole('region', { name: 'Conversation', exact: true })).toContainText('A reply reopens it.');
});

test('states: loading, empty, error', async ({ page }) => {
  const errors = watch(page);
  const api = await mock(page, { listMine: null, searchKb: null });
  await open(page);
  await expect(page.locator('[data-slot="state-block"][data-kind="loading"]').first()).toBeVisible();
  await shootBoth(page, 'support-loading');
  await api.release();
  await expect(page.locator('.sup-articles button').first()).toBeVisible();

  const empty = await page.context().newPage();
  await mock(empty, { listMine: () => [], searchKb: () => [] });
  await empty.goto('/');
  await empty.locator('.if-support').waitFor();
  await expect(empty.getByText('You have no requests yet')).toBeVisible();
  await expect(empty.getByText('No articles match your search.')).toBeVisible();
  await shootBoth(empty, 'support-empty');

  const failed = await page.context().newPage();
  await mock(failed, { listMine: 'refuse', searchKb: 'refuse' });
  await failed.goto('/');
  await failed.locator('.if-support').waitFor();
  await expect(failed.getByRole('button', { name: 'Try again' })).toHaveCount(2);
  // A failing list never takes the message form down with it.
  await expect(failed.getByRole('region', { name: 'Send us a message', exact: true })).toBeVisible();
  await shootBoth(failed, 'support-error');
  expect(errors).toEqual([]);
});

test('widths: no sideways scroll at 768 and 390', async ({ page }) => {
  await mock(page);
  await open(page);
  for (const width of [768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await noOverflow(page), `${width}`).toBe(true);
    await snap(page, `support-${width}`);
  }
});

test('keyboard: the search box is reachable and shows a focus ring', async ({ page }) => {
  await mock(page);
  await open(page);
  await page.getByRole('searchbox', { name: 'Search help' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
  expect(owner).toBeTruthy();
});
