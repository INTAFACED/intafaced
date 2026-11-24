/**
 * LOCAL TEST content for the founder's Home (HM-desks-03, J-home-ia-11 #3): founder a's TEST wallet, TEST venue funds and
 * a TEST partner balance, one TEST notice, and one inbox row. Called by local-test-seed.mjs `home` and `status`, after
 * its guard passed.
 *
 * Nothing here touches our ledger (OWNER 226: the TEST wallet, venue and partner balances come from the labelled TEST
 * adapters). Founder a's TEST wallet is a key kept only in the stack's state folder (mode 600), funded on the stack's
 * TEST chain once. Its TEST venue funds are paid in by the TEST venue's own deposit control under one fixed reference, so
 * a second run credits nothing. Founder a's and founder b's bank money is held at the TEST partner bank: each is paid
 * TEST money there once per fund id (the partner's figure, not a ledger post), and founder b pays founder a a TEST amount
 * under one fixed transfer id, which the partner moves and svc-notify files as founder a's one inbox row; a second run
 * sends the same transfer id, which the bank answers as the same transfer. The notice is drafted by founder a, approved by
 * founder b and published by founder a, as the notice desk does; while a published one with the same title is open, none
 * is drafted. Each window (30 days unless the caller sets one) has its own draft key, so once the notice has ended the next
 * run drafts a fresh one. Every figure here is an illustrative TEST value.
 */

// The Home's TEST values live in local-test-facts.mjs, so the journeys read them without this script.
import {
  HOME_PARTNER_ASSET,
  HOME_PARTNER_AMOUNT,
  HOME_SENDER_AMOUNT,
  HOME_TRANSFER_AMOUNT,
  HOME_VENUE_ASSET,
  HOME_VENUE_AMOUNT,
  HOME_NOTICE_TITLE,
  HOME_NOTICE_BODY,
  HOME_NOTICE_DAYS,
} from './local-test-facts.mjs';

export {
  HOME_PARTNER_ASSET,
  HOME_PARTNER_AMOUNT,
  HOME_SENDER_AMOUNT,
  HOME_TRANSFER_AMOUNT,
  HOME_VENUE_ASSET,
  HOME_VENUE_AMOUNT,
  HOME_NOTICE_TITLE,
  HOME_NOTICE_BODY,
  HOME_NOTICE_DAYS,
};
/** svc-notify's inbox row for a person-to-person payment received (services/svc-notify/src/events.ts). */
export const TRANSFER_RECEIVED_KIND = 'pay.transfer_received';
/** The one payment founder b makes to founder a: its business key, so a second run is the same payment. */
export const HOME_TRANSFER_ID = 'local-test-home:transfer:v1';
/** Each founder's TEST funding at the partner, once per fund id (`testPartner.fund`). */
export const HOME_FUND_IDS = Object.freeze({ a: 'local-test-home:fund:a:v1', b: 'local-test-home:fund:b:v1' });
/** The TEST venue deposit's fixed reference, so a second run credits nothing. */
export const HOME_VENUE_REF = 'local-test-home:venue-deposit:v1';
export const NOTICE_WINDOW_MS = HOME_NOTICE_DAYS * 24 * 60 * 60_000;
/** How long `home` waits for svc-notify's row after the payment. */
const WAIT_MS = 150_000;

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** The transfer-received rows in founder a's inbox that svc-notify filed for the seeded payment. */
async function receivedRows(home) {
  const page = data(await home.edge.query('notify', 'notify.list', { limit: 100 }, home.founder.token), 'notify.list');
  return page.items.filter((item) => item.kind === TRANSFER_RECEIVED_KIND && item.params?.transferId === HOME_TRANSFER_ID);
}

/** The published TEST notice that is open now (started, not ended), or null. */
async function seededNotice(home) {
  const rows = data(await home.edge.query('notify', 'notify.notices', { kind: 'announcement', limit: 100 }), 'notify.notices');
  const now = home.now();
  const open = (row) =>
    row.status === 'published' && (!row.startsAt || Date.parse(row.startsAt) <= now) && (!row.endsAt || Date.parse(row.endsAt) > now);
  return rows.find((row) => row.title === HOME_NOTICE_TITLE && open(row)) ?? null;
}

async function until(home, read, done) {
  const deadline = home.now() + WAIT_MS;
  let value = await read();
  while (!done(value) && home.now() < deadline) {
    await home.sleep(2_000);
    value = await read();
  }
  return value;
}

/** A founder's bank money held at the TEST partner (the launch model), paid TEST money there once per fund id. */
async function partnerFunded(home, who, fundId, amount) {
  data(await home.edge.mutate('bank', 'testPartner.set', { custody: 'off' }, who.token), `testPartner.set for ${who.handle}`);
  return data(
    await home.edge.mutate('bank', 'testPartner.fund', { fundId, assetId: HOME_PARTNER_ASSET, amount }, who.token),
    `testPartner.fund for ${who.handle}`,
  );
}

/** A founder's main space in the partner's asset, as their own bank reads it, or null. */
async function mainSpace(home, who) {
  const spaces = data(await home.edge.query('bank', 'spaces.list', { limit: 200 }, who.token), `spaces.list for ${who.handle}`);
  return spaces.find((space) => space.kind === 'primary' && space.assetId === HOME_PARTNER_ASSET) ?? null;
}

/** What the TEST partner says founder a holds there in its asset, from founder a's own bank read, or null. */
async function partnerHolding(home) {
  const space = await mainSpace(home, home.founder);
  return space?.heldAt ? { label: space.heldAt.label, amount: space.balance } : null;
}

async function applyNotice(home, noticeMs) {
  const existing = await seededNotice(home);
  if (existing) return { notice: 'skipped', id: existing.id };
  const now = home.now();
  const window = Math.floor(now / noticeMs);
  const row = await home.draftNotice(
    {
      kind: 'announcement',
      title: HOME_NOTICE_TITLE,
      body: HOME_NOTICE_BODY,
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + noticeMs).toISOString(),
    },
    `local-test-seed:home-notice:draft:v1:${noticeMs}:${window}`,
  );
  const published = await home.publishNotice(row, (approvalId) => `local-test-seed:home-notice:publish:${row.id}:${approvalId}`);
  return { notice: 'published', id: published.id };
}

/**
 * Makes Home's TEST content and waits for the inbox row. Returns report lines. `home` is the live wiring
 * (`homeDeps` in local-test-seed.mjs) or a test's stand-in. `noticeMs` is how long a newly drafted notice stays open
 * (a journey passes minutes, so the board it shares with other journeys empties soon after).
 */
export async function applyHome(home, { noticeMs = NOTICE_WINDOW_MS } = {}) {
  if (!Number.isSafeInteger(noticeMs) || noticeMs < 60_000 || noticeMs > NOTICE_WINDOW_MS) {
    throw new Error(`the TEST notice window must be a whole number of ms from 1 minute to ${HOME_NOTICE_DAYS} days`);
  }
  // Founder a's TEST wallet, funded on the TEST chain once, and its TEST venue funds under one fixed reference.
  const wallet = await home.wallet();
  const gas = await home.fundWallet(wallet.address);
  const venue = await home.venueDeposit(wallet.address, HOME_VENUE_ASSET, HOME_VENUE_AMOUNT, HOME_VENUE_REF);
  // Both founders' bank money at the TEST partner, and founder b's one TEST payment to founder a, which the partner moves.
  await partnerFunded(home, home.founder, HOME_FUND_IDS.a, HOME_PARTNER_AMOUNT);
  await partnerFunded(home, home.sender, HOME_FUND_IDS.b, HOME_SENDER_AMOUNT);
  const from = await mainSpace(home, home.sender);
  if (!from) throw new Error(`${home.sender.handle} has no ${HOME_PARTNER_ASSET} main space after the TEST partner paid in`);
  const paid = data(
    await home.edge.mutate(
      'bank',
      'transfers.toUser',
      { transferId: HOME_TRANSFER_ID, fromSpaceId: from.id, toUserId: home.founder.userId, amount: HOME_TRANSFER_AMOUNT },
      home.sender.token,
    ),
    'bank transfers.toUser',
  );
  if (paid.ledgerTxId !== null || !paid.partnerMove) {
    throw new Error(
      `the TEST payment to ${home.founder.handle} was not a partner move (ledger ${paid.ledgerTxId ?? 'none'}), so Home is not seeded`,
    );
  }
  const rows = await until(
    home,
    () => receivedRows(home),
    (found) => found.length > 0,
  );
  if (rows.length !== 1) throw new Error(`founder a's inbox has ${rows.length} rows for the TEST payment, not 1`);
  // The notice is published last, so a short window starts only once the money and the row are there.
  const notice = await applyNotice(home, noticeMs);
  return [
    `home wallet: ${wallet.address} on the TEST chain, ${gas}`,
    `home venue: ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET} at ${venue.name} for ${wallet.address}, ${venue.credited ? 'credited' : 'already there'}`,
    `home partner: ${HOME_PARTNER_AMOUNT} ${HOME_PARTNER_ASSET} at ${paid.partnerMove.label} for ${home.founder.handle}, and ${HOME_TRANSFER_AMOUNT} ${HOME_PARTNER_ASSET} from ${home.sender.handle}`,
    `home notice: ${HOME_NOTICE_TITLE} ${notice.notice}`,
    `home inbox: ${rows.length} transfer-received row for ${home.founder.handle}`,
  ];
}

/** What Home's TEST content is on this stack, read back from its sources; no content is written (the founders sign in). */
export async function homeStatus(home) {
  const wallet = await home.knownWallet();
  const venue = wallet ? await home.venueBalance(wallet.address, HOME_VENUE_ASSET) : null;
  const venueLine = !wallet ? 'none' : venue ? `${venue.total} ${HOME_VENUE_ASSET}  ${venue.name}` : 'no TEST venue running';
  const partner = await partnerHolding(home);
  const notice = await seededNotice(home);
  const rows = await receivedRows(home);
  return [
    'home:',
    `  wallet  ${wallet ? wallet.address : 'none'}`,
    `  venue  ${venueLine}`,
    `  partner  ${partner ? `${partner.amount} ${HOME_PARTNER_ASSET}  ${partner.label}` : 'none'}  ${home.founder.handle}`,
    `  notice  ${notice ? `${notice.title}  published` : 'none'}`,
    `  inbox  ${rows.length} transfer-received row${rows.length === 1 ? '' : 's'}  ${home.founder.handle}`,
  ];
}
