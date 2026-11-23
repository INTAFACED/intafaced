/**
 * LOCAL TEST content for the founder's Home (HM-desks-03, J-home-ia-11 #3): one TEST deposit, one TEST notice and the
 * inbox row the deposit files. Called by local-test-seed.mjs `home` and `status`, after its guard passed.
 *
 * Nothing here posts to the ledger. The deposit is a TEST chain transfer to founder a's own deposit address, delivered
 * to svc-pay's chain webhook the way the chain watcher delivers one (`local-test-stack.mjs chain-deposit`): svc-pay
 * credits it through its ledger-client recipe, keyed on the deposit, and announces it; svc-notify's deposit-credit
 * consumer files the inbox row. The transfer's label is fixed, so a second seed run delivers the same chain event again,
 * which svc-pay recognises: no second deposit, no second row. The notice is drafted by founder a, approved by founder b
 * and published by founder a, as the notice desk does; while a published one with the same title is open, none is
 * drafted. Each window (30 days unless the caller sets one) has its own draft key, so once the notice has ended the next run drafts a
 * fresh one.
 *
 * ON THE LAUNCH MODEL (OWNER 226: INTAFACED holds no customer money). With svc-trade's user-venue door on, Home shows
 * where the person stands, and the deposit above is not made: nothing here or behind it posts to our ledger. Founder a
 * gets instead, each from a labelled TEST adapter and each once per business key:
 *   - a TEST wallet: a fresh key kept in the stack's state folder (mode 600, never printed), funded on the stack's TEST
 *     chain when one runs;
 *   - TEST funds in that wallet's account on the TEST venue, by the venue's own TEST deposit control;
 *   - a TEST balance at the TEST partner bank: the partner pays TEST money in to founder b, and founder b sends it to
 *     founder a through the bank's own send, which the partner moves; svc-notify's consumer of posted sends files founder
 *     a's inbox row.
 * The seed asks the door itself which model the stack runs, and refuses a venue that is not TEST.
 * Every figure here is an illustrative TEST value.
 */

// The Home's TEST values live in local-test-facts.mjs, so the journeys read them without this script.
import {
  HOME_ASSET,
  HOME_NETWORK,
  HOME_DEPOSIT_AMOUNT,
  HOME_DEPOSIT_CONFIRMATIONS,
  HOME_DEPOSIT_LABEL,
  HOME_NOTICE_TITLE,
  HOME_NOTICE_BODY,
  HOME_NOTICE_DAYS,
  HOME_WALLET_FILE,
  HOME_VENUE_ASSET,
  HOME_VENUE_AMOUNT,
  HOME_VENUE_DEPOSIT_LABEL,
  HOME_PARTNER_AMOUNT,
  HOME_PARTNER_FUND_ID,
  HOME_PARTNER_TRANSFER_ID,
  HOME_PARTNER_NOTE,
} from './local-test-facts.mjs';

export {
  HOME_ASSET,
  HOME_NETWORK,
  HOME_DEPOSIT_AMOUNT,
  HOME_DEPOSIT_CONFIRMATIONS,
  HOME_DEPOSIT_LABEL,
  HOME_NOTICE_TITLE,
  HOME_NOTICE_BODY,
  HOME_NOTICE_DAYS,
  HOME_WALLET_FILE,
  HOME_VENUE_ASSET,
  HOME_VENUE_AMOUNT,
  HOME_VENUE_DEPOSIT_LABEL,
  HOME_PARTNER_AMOUNT,
  HOME_PARTNER_FUND_ID,
  HOME_PARTNER_TRANSFER_ID,
  HOME_PARTNER_NOTE,
};
/** svc-notify's inbox row for a credited deposit (services/svc-notify/src/deposit-credit-notice.ts). */
export const DEPOSIT_CREDITED_KIND = 'bank.deposit.credited';
/** svc-notify's inbox row for the person a posted send paid (services/svc-notify/src/events.ts, `personalTransferPosted`). */
export const TRANSFER_RECEIVED_KIND = 'pay.transfer_received';
export const NOTICE_WINDOW_MS = HOME_NOTICE_DAYS * 24 * 60 * 60_000;
/** How long apply waits for svc-pay's credit and svc-notify's row after the transfer is delivered. */
const WAIT_MS = 150_000;

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** The deposit-credited rows in founder a's inbox that svc-notify filed for transfer `txHash`. */
async function creditedRows(home, txHash) {
  const page = data(await home.edge.query('notify', 'notify.list', { limit: 100 }, home.founder.token), 'notify.list');
  return page.items.filter((item) => item.kind === DEPOSIT_CREDITED_KIND && item.params?.txHash === txHash);
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

async function depositAddress(home) {
  const row = data(
    await home.edge.mutate('bank', 'deposits.address', { assetId: HOME_ASSET, networkId: HOME_NETWORK }, home.founder.token),
    'bank deposits.address',
  );
  if (typeof row.address !== 'string' || row.address.length === 0) throw new Error('bank deposits.address gave no address');
  return row.address;
}

/** Founder a's first deposit address, read only (status writes nothing), or null before the seed asked for one. */
async function knownAddress(home) {
  const page = data(
    await home.edge.query('bank', 'deposits.addresses.list', { assetId: HOME_ASSET, networkId: HOME_NETWORK }, home.founder.token),
    'bank deposits.addresses.list',
  );
  return page.items.find((row) => row.addressIndex === 0)?.address ?? null;
}

/** The seeded deposit's record on founder a's deposit list, found by its tx id, or null before it is there. */
async function depositRecord(home, address) {
  const txId = home.txHash(address, HOME_DEPOSIT_LABEL);
  const page = data(
    await home.edge.query('bank', 'deposits.list', { assetId: HOME_ASSET, txId, offset: 0, limit: 10 }, home.founder.token),
    'bank deposits.list',
  );
  const rows = page.items.filter((row) => row.txHash === txId);
  if (rows.length > 1) throw new Error(`the TEST home deposit has ${rows.length} records, not 1`);
  return rows[0] ?? null;
}

// ── The launch model: a TEST wallet, TEST venue funds and a TEST partner balance ─────────────────────────────────────

/**
 * The TEST venue behind svc-trade's user-venue door, or null while the door is off (the stack then runs the custodial
 * layer, and Home's content is the TEST deposit). Asked of the door itself, as Home asks it. A door whose venue does not
 * answer, is not TEST, or is not the stack's own TEST venue refuses: the seed funds nothing anywhere else.
 */
async function launchVenue(home) {
  if (!home.venueDoor) return null;
  const door = await home.venueDoor();
  if (door?.enabled !== true) return null;
  if (door.available !== true) {
    throw new Error(`home: the user-venue door is on and its venue is not answering (${door.refusal?.code ?? 'no reason given'})`);
  }
  if (door.test !== true) throw new Error('refusing: the venue behind the user-venue door is not a TEST venue, so the seed funds nothing on it');
  const at = await home.testVenue('/venue');
  if (at.status !== 200 || at.json?.label !== 'TEST' || at.json?.venue?.id !== door.venue.id) {
    throw new Error(`refusing: the stack's TEST venue is not the venue behind the user-venue door (${door.venue.id})`);
  }
  const chainId = door.chainId ?? at.json.chainId;
  if (!Number.isSafeInteger(chainId)) throw new Error('refusing: the TEST venue names no chain, so its TEST deposit has no reference');
  return { id: door.venue.id, name: door.venue.displayName, chainId };
}

const venueAccount = (venue, owner) => ({ venueId: venue.id, owner: owner.toLowerCase(), subAccount: null });

/** What the TEST venue's own record holds of the seeded asset for `owner`, as a decimal string. */
async function venueTotal(home, venue, owner) {
  const res = await home.testVenue('/balances', { account: venueAccount(venue, owner) });
  if (res.status !== 200) throw new Error(`the TEST venue refused its balance read (${res.status}): ${String(res.text).slice(0, 300)}`);
  return res.json.value.find((row) => row.asset === HOME_VENUE_ASSET)?.total ?? '0';
}

/**
 * TEST funds in the wallet's account on the TEST venue, by the venue's TEST deposit control. The reference has the shape
 * of a chain transfer's id (`<chainId>:<txHash>:<logIndex>`) and is fixed for this wallet, so the venue credits it once.
 */
async function applyVenueFunds(home, venue, owner) {
  const depositRef = `${venue.chainId}:${home.txHash(owner, HOME_VENUE_DEPOSIT_LABEL)}:0`;
  const res = await home.testVenue('/test/deposit', {
    account: venueAccount(venue, owner),
    asset: HOME_VENUE_ASSET,
    amount: HOME_VENUE_AMOUNT,
    depositRef,
  });
  if (res.status !== 200 || typeof res.json?.credited !== 'boolean') {
    throw new Error(`the TEST venue refused the TEST home deposit (${res.status}): ${String(res.text).slice(0, 300)}`);
  }
  return { credited: res.json.credited, total: await venueTotal(home, venue, owner) };
}

/** The person's main balance of the seeded asset as the partner bank holds it (`heldAt`), or null when it holds none. */
async function partnerBalance(home, token, whose) {
  const spaces = data(await home.edge.query('bank', 'spaces.list', { limit: 200 }, token), `bank spaces.list (${whose})`);
  return spaces.find((space) => space.kind === 'primary' && space.assetId === HOME_ASSET && space.heldAt) ?? null;
}

/** Puts one founder's bank money at the TEST partner bank (its `custody: 'off'` switch): our ledger never holds it. */
async function heldAtPartner(home, token, whose) {
  const now = data(await home.edge.mutate('bank', 'testPartner.set', { custody: 'off' }, token), `bank testPartner.set (${whose})`);
  if (now.custody !== 'off') throw new Error(`the TEST partner bank does not hold ${whose}'s money (custody ${now.custody})`);
  return now.label;
}

/**
 * Founder a's TEST balance at the TEST partner bank: the partner pays TEST money in to founder b (once per fund id), and
 * founder b sends it to founder a through the bank's own send (once per transfer id), which the partner moves. A send
 * that the ledger posted instead is an error: on the launch model nothing of a person's is on our ledger.
 */
async function applyPartnerBalance(home) {
  const label = await heldAtPartner(home, home.founder.token, home.founder.handle);
  await heldAtPartner(home, home.sender.token, home.sender.handle);
  data(
    await home.edge.mutate(
      'bank',
      'testPartner.fund',
      { fundId: HOME_PARTNER_FUND_ID, assetId: HOME_ASSET, amount: HOME_PARTNER_AMOUNT },
      home.sender.token,
    ),
    'bank testPartner.fund',
  );
  const from = await partnerBalance(home, home.sender.token, home.sender.handle);
  if (!from) throw new Error(`the TEST partner bank holds no ${HOME_ASSET} balance for ${home.sender.handle} to send from`);
  const sent = data(
    await home.edge.mutate(
      'bank',
      'transfers.toUser',
      {
        transferId: HOME_PARTNER_TRANSFER_ID,
        fromSpaceId: from.id,
        toUserId: home.founder.userId,
        amount: HOME_PARTNER_AMOUNT,
        note: HOME_PARTNER_NOTE,
      },
      home.sender.token,
    ),
    'bank transfers.toUser',
  );
  if (!sent.partnerMove || sent.ledgerTxId !== null) {
    throw new Error('the TEST home send was not moved by the TEST partner bank (it has no partner move, or the ledger posted it)');
  }
  const held = await partnerBalance(home, home.founder.token, home.founder.handle);
  if (!held) throw new Error(`the TEST partner bank holds no ${HOME_ASSET} balance for ${home.founder.handle} after the TEST home send`);
  return { label, move: sent.partnerMove.id, balance: held.balance };
}

/** The transfer-received rows in founder a's inbox that svc-notify filed for the seeded send. */
async function receivedRows(home) {
  const page = data(await home.edge.query('notify', 'notify.list', { limit: 100 }, home.founder.token), 'notify.list');
  return page.items.filter((item) => item.kind === TRANSFER_RECEIVED_KIND && item.params?.transferId === HOME_PARTNER_TRANSFER_ID);
}

/** Home's TEST content on the launch model, in order: the wallet, its venue funds, the partner balance and its inbox row. */
async function applyLaunch(home, venue) {
  const wallet = await home.wallet({ create: true });
  const onChain = await home.fundWallet(wallet.address);
  const funds = await applyVenueFunds(home, venue, wallet.address);
  const partner = await applyPartnerBalance(home);
  const rows = await until(
    home,
    () => receivedRows(home),
    (found) => found.length > 0,
  );
  if (rows.length !== 1) throw new Error(`founder a's inbox has ${rows.length} transfer-received rows for the TEST home send, not 1`);
  return {
    lines: [
      `home wallet: TEST wallet ${wallet.address} for ${home.founder.handle}, ${wallet.created ? 'made' : 'kept'} (its TEST key is in ${HOME_WALLET_FILE}, never shown); on the TEST chain: ${onChain}`,
      `home venue: ${HOME_VENUE_AMOUNT} ${HOME_VENUE_ASSET} to ${wallet.address} at ${venue.name} (TEST), ${funds.credited ? 'credited' : 'already credited'}; the venue reports ${funds.total} ${HOME_VENUE_ASSET}`,
      `home partner: ${HOME_PARTNER_AMOUNT} ${HOME_ASSET} from ${home.sender.handle} to ${home.founder.handle} at ${partner.label} (TEST), partner move ${partner.move}; the partner reports ${partner.balance} ${HOME_ASSET}`,
    ],
    inbox: `home inbox: ${rows.length} transfer-received row for ${home.founder.handle}`,
  };
}

/** What the launch model's TEST content is on this stack, read back from each source; nothing is written. */
async function launchStatus(home, venue) {
  const wallet = await home.wallet({ create: false });
  const total = wallet ? await venueTotal(home, venue, wallet.address) : null;
  const held = await partnerBalance(home, home.founder.token, home.founder.handle);
  const rows = await receivedRows(home);
  return [
    `  wallet  ${wallet ? `TEST wallet ${wallet.address}` : 'none'}  ${home.founder.handle}`,
    `  venue  ${wallet ? `${total} ${HOME_VENUE_ASSET} at ${venue.name}` : 'none'}`,
    `  partner  ${held ? `${held.balance} ${HOME_ASSET} at ${held.heldAt.label}` : 'none'}  ${home.founder.handle}`,
    `  inbox  ${rows.length} transfer-received row${rows.length === 1 ? '' : 's'}  ${home.founder.handle}`,
  ];
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
 * Makes Home's TEST content and waits for the inbox row: the launch model's when the user-venue door is on, else the
 * custodial layer's TEST deposit. Returns report lines. `home` is the live wiring
 * (`homeDeps` in local-test-seed.mjs) or a test's stand-in. `noticeMs` is how long a newly drafted notice stays open
 * (a journey passes minutes, so the board it shares with other journeys empties soon after).
 */
export async function applyHome(home, { noticeMs = NOTICE_WINDOW_MS } = {}) {
  if (!Number.isSafeInteger(noticeMs) || noticeMs < 60_000 || noticeMs > NOTICE_WINDOW_MS) {
    throw new Error(`the TEST notice window must be a whole number of ms from 1 minute to ${HOME_NOTICE_DAYS} days`);
  }
  // The launch model: no deposit and nothing on our ledger. The notice is published last here too.
  const venue = await launchVenue(home);
  if (venue) {
    const launch = await applyLaunch(home, venue);
    const published = await applyNotice(home, noticeMs);
    return [...launch.lines, `home notice: ${HOME_NOTICE_TITLE} ${published.notice}`, launch.inbox];
  }
  const address = await depositAddress(home);
  home.chainDeposit(address, HOME_ASSET, HOME_DEPOSIT_AMOUNT, HOME_DEPOSIT_CONFIRMATIONS, HOME_DEPOSIT_LABEL);
  const record = await until(
    home,
    () => depositRecord(home, address),
    (row) => row?.status === 'credited',
  );
  if (!record || record.status !== 'credited') {
    throw new Error(`the TEST home deposit was not credited (record ${record ? record.status : 'missing'})`);
  }
  const tx = home.txHash(address, HOME_DEPOSIT_LABEL);
  const rows = await until(
    home,
    () => creditedRows(home, tx),
    (found) => found.length > 0,
  );
  if (rows.length !== 1) throw new Error(`founder a's inbox has ${rows.length} deposit-credited rows for the TEST home deposit, not 1`);
  // The notice is published last, so a short window starts only once the deposit and its row are there.
  const notice = await applyNotice(home, noticeMs);
  return [
    `home deposit: ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} on TEST ${HOME_NETWORK} to ${home.founder.handle}, ${record.status}`,
    `home notice: ${HOME_NOTICE_TITLE} ${notice.notice}`,
    `home inbox: ${rows.length} deposit-credited row for ${home.founder.handle}`,
  ];
}

/** What Home's TEST content is on this stack, read back from the services; no content is written (the founders sign in). */
export async function homeStatus(home) {
  const venue = await launchVenue(home);
  if (venue) {
    const [wallet, funds, partner, inbox] = await launchStatus(home, venue);
    const open = await seededNotice(home);
    return ['home:', wallet, funds, partner, `  notice  ${open ? `${open.title}  published` : 'none'}`, inbox];
  }
  const address = await knownAddress(home);
  const record = address ? await depositRecord(home, address) : null;
  const notice = await seededNotice(home);
  const rows = address ? await creditedRows(home, home.txHash(address, HOME_DEPOSIT_LABEL)) : [];
  return [
    'home:',
    `  deposit  ${record ? `${record.amount} ${HOME_ASSET} ${record.status}` : 'none'}  ${home.founder.handle}`,
    `  notice  ${notice ? `${notice.title}  published` : 'none'}`,
    `  inbox  ${rows.length} deposit-credited row${rows.length === 1 ? '' : 's'}  ${home.founder.handle}`,
  ];
}
