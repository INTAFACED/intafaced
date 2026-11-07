// World: none
import { randomBytes } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { asDesk, contactChannels, deskPeople } from './help-centre.mjs';
import { signIn, signUp } from './desk.mjs';
import { api, EDGE, json, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-support-public-05, in the running app (docs/roadmap/journeys.json): chat with a person from the site or the app,
// signed in or as a guest, with one support agent on the desk (founder B, appointed agent; founder A is the lead). Desk
// calls go through Edge as those two. Tests titled "J-support-public-05 #<n>" prove a step. Each step sets the desk's
// availability it starts from, so it can run alone.
const J = 'J-support-public-05';
const RUN = Date.now().toString(36);
const CHAT_SLOT = 'intafaced.support.chat.v1';

const key = () => randomBytes(32).toString('base64url');

async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** A desk call that must succeed. */
async function desk(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}

/** Sets the lead's and the agent's availability, as each would on the desk. */
async function availability({ lead, agent }) {
  await desk('lead', 'mutation', 'staffSetAvailability', { availability: lead });
  await desk('agent', 'mutation', 'staffSetAvailability', { availability: agent });
}

/** A support call from a page with no session of ours (a guest, or a page embedding the chat). */
async function anonymous(procedure, input) {
  return json(
    await fetch(`${EDGE}/api/support/trpc/${procedure}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}

/** The chat this browser tab keeps (its session id and access token), as the chat room stored it. */
async function keptChat(page) {
  const raw = await page.evaluate((slot) => sessionStorage.getItem(slot), CHAT_SLOT);
  expect(raw, 'the chat room keeps its open chat in this tab').toBeTruthy();
  return JSON.parse(raw);
}

/** The desk's view of one chat. */
const deskChat = (sessionId, after = 0) => desk('agent', 'query', 'chatDeskPoll', { sessionId, after });

/** A signed-in customer in the chat room, with their chat opened from the page. */
async function customerInChat(browser, prefix, message) {
  const page = await visitor(browser);
  const who = await signUp(page, prefix);
  await signIn(page, who);
  await page.goto('/support/chat');
  const room = page.getByTestId('support-chat');
  await room.getByLabel('Your message').fill(message);
  await room.getByRole('button', { name: 'Start chat' }).click();
  await expect(room.getByTestId('support-chat-message').filter({ hasText: message })).toBeVisible();
  const kept = await keptChat(page);
  return { page, room, who, kept };
}

test(`${J} #1 with no agent online, the chat panel shows the request form and the support hours, or that hours are not set`, async ({
  browser,
}) => {
  await availability({ lead: 'offline', agent: 'offline' });
  const page = await visitor(browser);
  await page.goto('/support/chat');
  const room = page.getByTestId('support-chat');
  const offline = room.getByTestId('support-chat-offline');
  await expect(offline).toBeVisible();
  await expect(offline.getByRole('link', { name: 'Send a request instead' })).toHaveAttribute('href', '/support/new');
  const { chatHours } = await contactChannels();
  if (chatHours) await expect(offline.getByTestId('support-chat-hours')).toContainText(chatHours);
  else await expect(offline.getByTestId('support-chat-hours-unset')).toHaveText('Support hours are not set.');
  // The request form the link opens is the real one.
  await offline.getByRole('link', { name: 'Send a request instead' }).click();
  await expect(page).toHaveURL(/\/support\/new$/);
  // Nothing can be opened while nobody is on the desk.
  const res = await anonymous('chatOpen', {
    clientKey: key(),
    prechat: { name: 'TEST', email: `j05-${RUN}@local-test.invalid` },
    message: 'TEST hi',
  });
  expect(JSON.stringify(res.body)).toContain('support.chat_agent_unavailable');
  await page.context().close();
});

test(`${J} #2 a guest fills in the pre-chat form: the chat opens and one enquiry record exists with source chat`, async ({ browser }) => {
  await availability({ lead: 'offline', agent: 'online' });
  const page = await visitor(browser);
  await page.goto('/support/chat');
  const room = page.getByTestId('support-chat');
  const message = `TEST ${J} ${RUN} guest question`;
  await room.getByLabel('Your name').fill(`TEST Guest ${RUN}`);
  await room.getByLabel('Your email').fill(`j05-guest-${RUN}@local-test.invalid`);
  await room.getByLabel('Your message').fill(message);
  await room.getByRole('button', { name: 'Start chat' }).click();
  await expect(room).toHaveAttribute('data-chat-status', /waiting|active/);
  await expect(room.getByTestId('support-chat-message').filter({ hasText: message })).toBeVisible();
  const { sessionId } = await keptChat(page);
  // The desk sees the chat as a guest's, and exactly one enquiry from it, with source chat and no address answered back.
  const inbox = await desk('agent', 'query', 'chatInbox', { limit: 200 });
  expect(inbox.find((s) => s.id === sessionId)).toMatchObject({ identity: 'guest', userId: null });
  const enquiries = await desk('agent', 'query', 'chatEnquiries', { sessionId, limit: 10 });
  expect(enquiries).toHaveLength(1);
  expect(enquiries[0]).toMatchObject({ source: 'chat', sessionId, name: `TEST Guest ${RUN}`, hasEmail: true });
  expect(JSON.stringify(enquiries)).not.toContain(`j05-guest-${RUN}@`);
  // Reloading the page comes back to the same chat and makes no second enquiry.
  await page.reload();
  await expect(room.getByTestId('support-chat-message').filter({ hasText: message })).toBeVisible();
  expect(await desk('agent', 'query', 'chatEnquiries', { sessionId, limit: 10 })).toHaveLength(1);
  await page.context().close();
});

test(`${J} #3 signed in, a page that names a different identity: their own signed identity is used, the false claim fails, and with no session of ours the chat is a guest's`, async ({
  browser,
}) => {
  await availability({ lead: 'offline', agent: 'online' });
  const page = await visitor(browser);
  const me = await signUp(page, 'j05me');
  const other = await signUp(await visitor(browser), 'j05ot');
  const mine = await api(me);
  const theirs = await api(other);
  // A real claim, but svc-support signed it for the other account.
  const claim = (await theirs.post('/api/support/trpc/chatIdentityToken')).body?.result?.data?.token;
  expect(claim, 'the other account can get a claim for itself').toBeTruthy();

  // Signed in as me, the page names the other account: my own signed identity is used and the claim fails.
  const signedIn = await mine.post('/api/support/trpc/chatOpen', {
    clientKey: key(),
    identity: claim,
    message: `TEST ${J} ${RUN} #3 signed in`,
  });
  expect(signedIn.status, JSON.stringify(signedIn.body).slice(0, 300)).toBe(200);
  const opened = signedIn.body.result.data.session;
  expect(opened).toMatchObject({ identity: 'account', claim: 'refused', claimRefusal: 'support.chat_identity_invalid' });
  expect((await deskChat(opened.id)).session.userId).toBe(mine.userId);

  // The same false claim from a page with no session of ours fails too, and that chat is a guest's: it names nobody.
  const [payload, signature] = claim.split('.');
  const renamed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), u: mine.userId })).toString(
    'base64url',
  );
  for (const forged of [`${renamed}.${signature}`, `not-a-claim-${RUN}`]) {
    const res = await anonymous('chatOpen', {
      clientKey: key(),
      identity: forged,
      prechat: { name: 'TEST', email: `j05-${RUN}@local-test.invalid` },
      message: 'TEST #3',
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    const guest = res.body.result.data.session;
    expect(guest).toMatchObject({ identity: 'guest', claim: 'refused', claimRefusal: 'support.chat_identity_invalid' });
    expect((await deskChat(guest.id)).session.userId).toBeNull();
  }
  // And the chat room in the browser, signed in, is the signed-in account's own.
  await signIn(page, me);
  await page.goto('/support/chat');
  const room = page.getByTestId('support-chat');
  await room.getByLabel('Your message').fill(`TEST ${J} ${RUN} #3 from the page`);
  await expect(room.getByLabel('Your name')).toHaveCount(0);
  await room.getByRole('button', { name: 'Start chat' }).click();
  await expect(room).toHaveAttribute('data-chat-status', /waiting|active/);
  expect((await deskChat((await keptChat(page)).sessionId)).session).toMatchObject({
    identity: 'account',
    userId: mine.userId,
    claim: 'none',
  });
  await page.context().close();
});

test(`${J} #4 an agent switches to busy, then to online: the directory shows busy, the chat waits for an online agent, and offline appears after the heartbeat window`, async ({
  browser,
}) => {
  const { agent } = await deskPeople();
  await availability({ lead: 'offline', agent: 'busy' });
  const directory = async () => (await desk('lead', 'query', 'staffList', undefined)).find((m) => m.userId === agent);
  expect((await directory()).availability).toBe('busy');

  const page = await visitor(browser);
  const who = await signUp(page, 'j05ag');
  await page.context().close();
  const customer = await api(who);
  const res = await customer.post('/api/support/trpc/chatOpen', { clientKey: key(), message: `TEST ${J} ${RUN} #4 waiting` });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const sessionId = res.body.result.data.session.id;
  expect(res.body.result.data.session.waitingForAgent).toBe(true);
  // A busy agent cannot take it: it waits for an online one.
  const taken = await asDesk('agent', 'mutation', 'chatAccept', { sessionId });
  expect(taken.text).toContain('support.chat_agent_not_online');
  expect((await deskChat(sessionId)).session).toMatchObject({ status: 'waiting', agentId: null });

  await desk('agent', 'mutation', 'staffSetAvailability', { availability: 'online' });
  expect((await directory()).availability).toBe('online');
  expect(await desk('agent', 'mutation', 'chatAccept', { sessionId })).toMatchObject({ status: 'active', agentId: agent });
  const read = await customer.post('/api/support/trpc/chatPoll', { sessionId, after: 0 });
  expect(read.body.result.data.session.waitingForAgent).toBe(false);

  // With no heartbeat, the agent reads offline once the owner's window has passed (a TEST value on this stack).
  const policy = await desk('lead', 'query', 'staffAvailabilityPolicy', undefined);
  expect(policy.automaticOffline).toBe('set');
  await new Promise((resolve) => setTimeout(resolve, (policy.heartbeatWindowSeconds + 2) * 1000));
  expect((await directory()).availability).toBe('offline');
});

test(`${J} #5 a message reaches the agent within the poll interval, the reply appears, and the same message sent twice is stored once`, async ({
  browser,
}) => {
  await availability({ lead: 'offline', agent: 'online' });
  const { page, room, who, kept } = await customerInChat(browser, 'j05ms', `TEST ${J} ${RUN} #5 hello`);
  await desk('agent', 'mutation', 'chatAccept', { sessionId: kept.sessionId });
  const shown = await page.getByTestId('support-chat-poll').innerText();
  const seconds = Number(/(\d+) seconds/.exec(shown)?.[1]);
  expect(seconds, `the page says how often it reads: ${shown}`).toBeGreaterThan(0);

  // The customer sends; the agent's next read, no later than one interval after, has it.
  const body = `TEST ${J} ${RUN} #5 where is my deposit?`;
  await room.getByLabel('Message').fill(body);
  await room.getByRole('button', { name: 'Send' }).click();
  await expect(room.getByTestId('support-chat-message').filter({ hasText: body })).toBeVisible();
  const sentAt = Date.now();
  let seen = null;
  while (!seen && Date.now() - sentAt <= seconds * 1000) {
    seen = (await deskChat(kept.sessionId)).messages.find((m) => m.body === body) ?? null;
    if (!seen) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(seen, `the agent sees it within ${seconds} s`).toBeTruthy();
  expect(seen.author).toBe('customer');

  // The agent replies; it appears for the customer within one interval (plus the request itself).
  const reply = `TEST ${J} ${RUN} #5 let me check that for you`;
  await desk('agent', 'mutation', 'chatReply', { sessionId: kept.sessionId, clientMessageId: `j05:${RUN}:reply`, body: reply });
  await expect(room.getByTestId('support-chat-message').filter({ hasText: reply })).toBeVisible({ timeout: seconds * 1000 + 1500 });
  await expect(room.getByTestId('support-chat-state')).toHaveText('A person on our team has joined.');

  // The same message sent twice (the same key, as a page does after a lost answer) is stored once.
  const customer = await api(who);
  const twice = { sessionId: kept.sessionId, clientMessageId: `j05:${RUN}:twice`, body: `TEST ${J} ${RUN} #5 sent twice` };
  const first = await customer.post('/api/support/trpc/chatSend', twice);
  const second = await customer.post('/api/support/trpc/chatSend', twice);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body.result.data.id).toBe(first.body.result.data.id);
  const stored = (await deskChat(kept.sessionId)).messages.filter((m) => m.body === twice.body);
  expect(stored).toHaveLength(1);
  await page.reload();
  await expect(room.getByTestId('support-chat-message').filter({ hasText: twice.body })).toHaveCount(1);
  await page.context().close();
});

test(`${J} #6 a business customer's chat becomes a request carrying the business profile type read from the identity service`, async ({
  browser,
}) => {
  await availability({ lead: 'offline', agent: 'online' });
  const page = await visitor(browser);
  const handle = `j05bz${Date.now().toString(36)}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who, { accountType: 'business' });
  await page.context().close();
  const customer = await api(who);
  const opened = await customer.post('/api/support/trpc/chatOpen', { clientKey: key(), message: `TEST ${J} ${RUN} #6 business question` });
  expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(200);
  const sessionId = opened.body.result.data.session.id;
  expect((await deskChat(sessionId)).session).toMatchObject({ profileType: 'business', profileRead: 'read' });
  const closed = await customer.post('/api/support/trpc/chatClose', { sessionId });
  expect(closed.status, JSON.stringify(closed.body).slice(0, 300)).toBe(200);
  const ticketId = closed.body.result.data.ticketId;
  expect(ticketId).toBeTruthy();
  expect(await desk('agent', 'query', 'requestSource', { ticketId })).toMatchObject({
    ticketId,
    source: 'chat',
    sessionId,
    profileType: 'business',
    profileRead: 'read',
  });
  // An individual's chat carries individual, so the type is read, not assumed.
  const person = await api(await signUp(await visitor(browser), 'j05in'));
  const theirs = await person.post('/api/support/trpc/chatOpen', { clientKey: key(), message: `TEST ${J} ${RUN} #6 personal question` });
  expect((await deskChat(theirs.body.result.data.session.id)).session.profileType).toBe('individual');
});

test(`${J} #7 asking to continue by email: without a mailbox the notice names vendor.email and the chat stays open`, async ({
  browser,
}) => {
  await availability({ lead: 'offline', agent: 'online' });
  const { page, room, kept } = await customerInChat(browser, 'j05em', `TEST ${J} ${RUN} #7 email me`);
  await room.getByRole('button', { name: 'Continue by email' }).click();
  const notice = room.getByTestId('support-chat-email-notice');
  await expect(notice).toBeVisible();
  await expect(notice.locator('[data-not-connected="vendor.email"]')).toContainText(
    'Continuing this chat by email needs an email delivery provider.',
  );
  await expect(notice).toContainText('vendor.email');
  // Nothing was lost: the chat is still open and takes a message.
  await expect(room).not.toHaveAttribute('data-chat-status', 'closed');
  const after = `TEST ${J} ${RUN} #7 still here`;
  await room.getByLabel('Message').fill(after);
  await room.getByRole('button', { name: 'Send' }).click();
  await expect(room.getByTestId('support-chat-message').filter({ hasText: after })).toBeVisible();
  expect((await deskChat(kept.sessionId)).session.status).not.toBe('closed');
  await page.context().close();
});

test(`${J} #8 closing the chat leaves one request holding the transcript, and the chat cannot be written to`, async ({ browser }) => {
  await availability({ lead: 'offline', agent: 'online' });
  const opening = `TEST ${J} ${RUN} #8 my card was declined`;
  const { page, room, who, kept } = await customerInChat(browser, 'j05cl', opening);
  await desk('agent', 'mutation', 'chatAccept', { sessionId: kept.sessionId });
  const reply = `TEST ${J} ${RUN} #8 thanks, I have noted it`;
  await desk('agent', 'mutation', 'chatReply', { sessionId: kept.sessionId, clientMessageId: `j05:${RUN}:r8`, body: reply });
  await expect(room.getByTestId('support-chat-message').filter({ hasText: reply })).toBeVisible({ timeout: 10_000 });

  await room.getByRole('button', { name: 'End chat' }).click();
  const closed = room.getByTestId('support-chat-closed');
  await expect(closed).toBeVisible();
  await expect(room).toHaveAttribute('data-chat-status', 'closed');
  await expect(room.getByLabel('Message')).toHaveCount(0);

  const customer = await api(who);
  const again = await customer.post('/api/support/trpc/chatClose', { sessionId: kept.sessionId });
  const ticketId = again.body.result.data.ticketId;
  expect(ticketId).toBeTruthy();
  // One request: closing again names the same one, and the customer has exactly one.
  const mine = await customer.get(`/api/support/trpc/listMine?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(mine.body.result.data.map((t) => t.id)).toEqual([ticketId]);
  // It holds the transcript: every message, in order.
  const source = await desk('lead', 'query', 'requestSource', { ticketId });
  expect(source.transcript.map((m) => m.body)).toEqual([opening, reply]);
  const ticket = await desk('lead', 'query', 'get', { ticketId });
  expect(ticket.body).toContain(opening);
  expect(ticket.body).toContain(reply);
  // The closed chat cannot be written to, by the customer or the agent.
  const write = await customer.post('/api/support/trpc/chatSend', {
    sessionId: kept.sessionId,
    clientMessageId: `j05:${RUN}:late`,
    body: 'TEST late',
  });
  expect(JSON.stringify(write.body)).toContain('support.chat_closed');
  const late = await asDesk('agent', 'mutation', 'chatReply', {
    sessionId: kept.sessionId,
    clientMessageId: `j05:${RUN}:late-r`,
    body: 'TEST late',
  });
  expect(late.text).toContain('support.chat_closed');
  // And the page links the request.
  await closed.getByRole('link', { name: 'Open the request' }).click();
  await expect(page).toHaveURL(new RegExp(`/support/tickets/${ticketId}$`));
  await page.context().close();
});
