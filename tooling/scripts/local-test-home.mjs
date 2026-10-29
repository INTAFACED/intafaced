/**
 * LOCAL TEST content for the founder's Home (HM-desks-03, J-home-ia-11 #3): one TEST deposit, one TEST notice and the
 * inbox row the deposit files. Called by local-test-seed.mjs `apply` and `status`, after its guard passed.
 *
 * Nothing here posts to the ledger. The deposit is a TEST chain transfer to founder a's own deposit address, delivered
 * to svc-pay's chain webhook the way the chain watcher delivers one (`local-test-stack.mjs chain-deposit`): svc-pay
 * credits it through its ledger-client recipe, keyed on the deposit, and announces it; svc-notify's deposit-credit
 * consumer files the inbox row. The transfer's label is fixed, so a second seed run delivers the same chain event again,
 * which svc-pay recognises: no second deposit, no second row. The notice is drafted by founder a, approved by founder b
 * and published by founder a, as the notice desk does; a published one with the same title is not drafted again.
 * Every figure here is an illustrative TEST value.
 */

export const HOME_ASSET = 'USDT';
export const HOME_NETWORK = 'ethereum';
export const HOME_DEPOSIT_AMOUNT = '100';
/** The published minimum on TEST Ethereum is 6 confirmations (local-test-gates.mjs TEST_DEPOSIT_TERMS). */
export const HOME_DEPOSIT_CONFIRMATIONS = 6;
/** One fixed transfer: the same label to the same address is the same chain event (local-test-stack.mjs chainTxHash). */
export const HOME_DEPOSIT_LABEL = 'LOCAL-TEST-seed-home-deposit-v1';
export const HOME_NOTICE_TITLE = 'TEST · This is a test build';
export const HOME_NOTICE_BODY = 'TEST notice from the tester seed. Balances here are TEST funds, not real money.';
/** The TEST notice stays open as long as a test stack is likely to live. */
export const HOME_NOTICE_DAYS = 30;
/** svc-notify's inbox row for a credited deposit (services/svc-notify/src/deposit-credit-notice.ts). */
export const DEPOSIT_CREDITED_KIND = 'bank.deposit.credited';
const INBOX_WAIT_MS = 150_000;

const data = (res, what) => {
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${what} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
};

/** The deposit-credited rows in founder a's inbox. */
async function creditedRows(home) {
  const page = data(await home.edge.query('notify', 'notify.list', { limit: 100 }, home.founder.token), 'notify.list');
  return page.items.filter((item) => item.kind === DEPOSIT_CREDITED_KIND);
}

async function seededNotice(home) {
  const rows = data(await home.edge.query('notify', 'notify.notices', { limit: 50 }), 'notify.notices');
  return rows.find((row) => row.title === HOME_NOTICE_TITLE) ?? null;
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

async function applyNotice(home) {
  const existing = await seededNotice(home);
  if (existing) return { notice: 'skipped', id: existing.id };
  const row = await home.draftNotice({
    kind: 'announcement',
    title: HOME_NOTICE_TITLE,
    body: HOME_NOTICE_BODY,
    minutes: HOME_NOTICE_DAYS * 24 * 60,
    key: 'local-test-seed-home-v1',
  });
  const published = await home.publishNotice(row, 'local-test-seed-home-v1');
  return { notice: 'published', id: published.id };
}

/**
 * Makes Home's TEST content and waits for the inbox row. Returns report lines. `home` is the live wiring
 * (`homeDeps` in local-test-seed.mjs) or a test's stand-in.
 */
export async function applyHome(home) {
  const address = await depositAddress(home);
  home.chainDeposit(address, HOME_ASSET, HOME_DEPOSIT_AMOUNT, HOME_DEPOSIT_CONFIRMATIONS, HOME_DEPOSIT_LABEL);
  const record = await depositRecord(home, address);
  if (!record || record.status !== 'credited') {
    throw new Error(`the TEST home deposit was not credited (record ${record ? record.status : 'missing'})`);
  }
  const notice = await applyNotice(home);
  const deadline = home.now() + INBOX_WAIT_MS;
  let rows = await creditedRows(home);
  while (rows.length === 0 && home.now() < deadline) {
    await home.sleep(2_000);
    rows = await creditedRows(home);
  }
  if (rows.length !== 1) throw new Error(`founder a's inbox has ${rows.length} deposit-credited rows, not 1`);
  return [
    `home deposit: ${HOME_DEPOSIT_AMOUNT} ${HOME_ASSET} on TEST ${HOME_NETWORK} to ${home.founder.handle}, ${record.status}`,
    `home notice: ${HOME_NOTICE_TITLE} ${notice.notice}`,
    `home inbox: ${rows.length} deposit-credited row for ${home.founder.handle}`,
  ];
}

/** What Home's TEST content is on this stack, read back from the services; nothing is written. */
export async function homeStatus(home) {
  const address = await knownAddress(home);
  const record = address ? await depositRecord(home, address) : null;
  const notice = await seededNotice(home);
  const rows = await creditedRows(home);
  return [
    'home:',
    `  deposit  ${record ? `${record.amount} ${HOME_ASSET} ${record.status}` : 'none'}  ${home.founder.handle}`,
    `  notice  ${notice ? `${notice.title}  published` : 'none'}`,
    `  inbox  ${rows.length} deposit-credited row${rows.length === 1 ? '' : 's'}  ${home.founder.handle}`,
  ];
}
