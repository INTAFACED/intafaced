import { expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';

// The founder console's protocol desks (/protocol-ops, /trade-ops) for the operator journeys J-dex-protocol-29 to -32.
// Every write there is a two-founder request: founder A asks and gets a request packet, founder B pastes it into their
// own console and approves, and A runs the approved request (as in J-ops-console-07). The console nests a <main> in a
// <main>, so a desk is read from the outer one.

/** The desk's outer main. */
export const desk = (page) => page.getByRole('main').first();

/** Two founder pages for this worker, signed in once each and kept for the file's tests. */
export function founderPair() {
  const pages = {};
  return async (browser) => {
    for (const key of ['a', 'b']) {
      if (pages[key]) continue;
      pages[key] = await (await browser.newContext()).newPage();
      await founderSignIn(pages[key], key);
    }
    return pages;
  };
}

/** Opens a console path and waits for its first heading. */
export async function openDesk(page, path, heading, wait = { timeout: 30_000 }) {
  await page.goto(`${ADMIN}${path}`, { waitUntil: 'load' });
  await expect(desk(page).getByRole('heading', { name: heading, level: 1 })).toBeVisible(wait);
}

/**
 * Founder A has filled a request on `formA` and presses `ask` (or has already asked, when `ask` is null); founder B
 * approves the packet on `formB`, which must summarise it as `summary`; A then runs it. `phrase` is the typed confirmation. Returns the reply A's desk shows.
 */
export async function twoFounder({ formA, formB, ask, phrase, summary }) {
  if (ask) await formA.getByRole('button', { name: ask }).click();
  await expect(formA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packet = (await formA.getByLabel('Request packet').inputValue()).trim();
  await formB.getByLabel('Request packet').fill(packet);
  await expect(formB.getByTestId('packet-summary')).toContainText(summary);
  await formB.getByLabel(/to approve or run it$/).fill(phrase);
  await formB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(formB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });
  await formA.getByLabel(/to approve or run it$/).fill(phrase);
  await formA.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = formA.getByTestId('step-reply');
  await expect(reply).toContainText('The service answered', { timeout: 60_000 });
  return (await reply.innerText()).replace(/\s+/g, ' ');
}
