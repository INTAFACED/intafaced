import { expect, test } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { ADMIN, founderSignIn } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { api } from './stack.mjs';

// J-ops-console-02 #5: a founder opens one customer's documents list and sees each document with its status, then opens one
// in the viewer. A fresh TEST customer asks for full verification; the stack's two TEST operators store two TEST documents in
// identity's vault for them and attach the image to that pending verification. Identity serves a document's contents only
// with a second founder's approval, so founder A asks, founder B approves the same document, and A's run shows it, once.

/** A small LABELLED TEST image (an orange square), made here so no real document is ever used. */
function testPng(size = 24) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([len, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [0xf2, 0x8c, 0x28]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0LOCAL TEST document, not a real person', 'latin1')),
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TEST_PDF = Buffer.from('%PDF-1.4\n% LOCAL TEST document, not a real person\n%%EOF\n', 'latin1');

test('J-ops-console-02 #5 the documents list shows each document with its status, and the viewer opens with a second founder', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  // A TEST customer with a pending full verification, and two TEST documents: the image attached to that verification, the PDF not.
  const who = await unconfirmedAccount('jdoc');
  const customer = await api(who);
  const submitted = await customer.post('/api/identity/trpc/kyc.submit', { tier: 'full', jurisdiction: 'DE' });
  const record = submitted.body?.result?.data;
  expect(record?.status, JSON.stringify(submitted.body).slice(0, 300)).toBe('pending');
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const image = await gates.storeTestKycDocument(ctx, { userId: record.userId, contentType: 'image/png', bytes: testPng() });
  const pdf = await gates.storeTestKycDocument(ctx, { userId: record.userId, contentType: 'application/pdf', bytes: TEST_PDF });
  await gates.bindTestKycDocument(ctx, { recordId: record.id, documentId: image.id });

  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');
  try {
    // Founder A opens the customer's documents: each document with its status.
    await a.goto(`${ADMIN}/accounts/${record.userId}`, { waitUntil: 'load' });
    await a.getByTestId('customer-tab-documents').click();
    const list = a.getByTestId('read-identity.documents');
    await expect(list.getByRole('table')).toBeVisible({ timeout: 60_000 });
    await expect(list.locator('tbody tr')).toHaveCount(2);
    const rows = list.locator('tbody > tr');
    // Newest first: the PDF, then the image.
    await expect(rows.nth(0)).toContainText('application/pdf');
    await expect(rows.nth(0)).toContainText('Not attached to a verification');
    await expect(rows.nth(1)).toContainText('image/png');
    await expect(rows.nth(1)).toContainText('pending');
    await expect(a.getByTestId('unwired-documents.decisions')).toContainText('no source');

    // A opens the image's row and asks to open it.
    await rows.nth(1).getByRole('button', { name: 'Open' }).click();
    const detail = list.getByTestId('row-detail');
    await expect(detail).toContainText(image.id);
    await expect(detail).toContainText(record.id);
    const phrase = `OPEN DOCUMENT ${image.id.slice(0, 8)}`;
    const deskA = detail.getByTestId('control-desk');
    await deskA.getByLabel(/to confirm$/).fill(phrase);
    await deskA.getByRole('button', { name: 'Ask a second founder to approve opening it' }).click();
    await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    const packet = (await deskA.getByLabel('Request packet').inputValue()).trim();
    // A cannot approve their own request.
    await expect(deskA.getByRole('button', { name: 'Approve this request' })).toBeDisabled();

    // Founder B approves that exact document on their own console.
    await b.goto(`${ADMIN}/accounts/${record.userId}?tab=documents`, { waitUntil: 'load' });
    const listB = b.getByTestId('read-identity.documents');
    await listB.locator('tbody > tr').nth(1).getByRole('button', { name: 'Open' }).click();
    const deskB = listB.getByTestId('row-detail').getByTestId('control-desk');
    await deskB.getByLabel('Request packet').fill(packet);
    await expect(deskB.getByTestId('packet-summary')).toContainText(`Open KYC document ${image.id}`);
    await deskB.getByLabel(/to approve or run it$/).fill(phrase);
    await deskB.getByRole('button', { name: 'Approve this request' }).click();
    await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
    // The approver cannot open it: the document opens only for the founder who asked.
    await expect(deskB.getByRole('button', { name: 'Run the approved request' })).toBeDisabled();
    await expect(deskB).toContainText('Only the founder who asked to open this document can open it.');

    // A runs it: the viewer opens with the image identity decrypted, on A's page only.
    await deskA.getByLabel(/to approve or run it$/).fill(phrase);
    await deskA.getByRole('button', { name: 'Run the approved request' }).click();
    const viewer = deskA.getByTestId('kyc-document-viewer');
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    await expect(viewer).toHaveAttribute('data-document', image.id);
    await expect(viewer).toContainText('image/png');
    const drawn = viewer.getByTestId('kyc-document-image');
    await expect(drawn).toBeVisible();
    expect(await drawn.evaluate((img) => [img.complete, img.naturalWidth, img.naturalHeight])).toEqual([true, 24, 24]);
    await expect(b.getByTestId('kyc-document-viewer')).toHaveCount(0);

    // Closing the viewer drops the contents from the page; the approval was spent on that read, so running it again refuses.
    await viewer.getByRole('button', { name: 'Close the document' }).click();
    await expect(deskA.getByTestId('step-reply')).toContainText('Document closed. Its contents are no longer on this page');
    await expect(deskA.getByTestId('kyc-document-image')).toHaveCount(0);
    await deskA.getByLabel(/to approve or run it$/).fill(phrase);
    await deskA.getByRole('button', { name: 'Run the approved request' }).click();
    await expect(deskA.getByTestId('step-reply')).toHaveAttribute('data-tone', /danger|warn/, { timeout: 60_000 });
    await expect(deskA.getByTestId('kyc-document-viewer')).toHaveCount(0);
    expect(pdf.contentType).toBe('application/pdf');

    // The same viewer as the KYC case: A opens the case for the verification this image is attached to, then its detail,
    // and opens the document from there. The case is found by the service's own lookup of this person's cases (the KYC case
    // history, newest first, by user id), so it never depends on the pending queue's loaded window.
    await a.goto(`${ADMIN}/tools`, { waitUntil: 'load' });
    await a.getByRole('button', { name: /^KYC case history/ }).click();
    await a.locator('#tool-field-userId').fill(record.userId);
    await a.locator('#tool-field-limit').fill('20');
    await a.getByRole('button', { name: 'Run query' }).click();
    const kycCase = a.getByTestId('delivery-receipt');
    await expect(kycCase, 'the KYC case history answers for this person').toContainText(record.id, { timeout: 60_000 });
    // The case detail has to offer a way to open its attached document, and that way has to be the same viewer on the same
    // document. The product's case detail offers neither (kyc-document-viewer.tsx: "so will a KYC case's detail
    // (OPS-cases-07)"), so both clauses fail by name; once the feature exists they pass through the real flow.
    const openFromCase = kycCase.getByRole('button', { name: /open/i });
    await expect
      .soft(openFromCase.first(), 'the KYC case detail offers an action to open its attached document: it has none (OPS-cases-07)')
      .toBeVisible({ timeout: 5_000 });
    if ((await openFromCase.count()) > 0) await openFromCase.first().click();
    await expect
      .soft(
        a.locator(`[data-testid="kyc-document-viewer"][data-document="${image.id}"]`),
        'the KYC case detail shows its attached document in the same viewer (kyc-document-viewer) as the documents tab: the case detail has no document viewer (OPS-cases-07)',
      )
      .toBeVisible({ timeout: 5_000 });
  } finally {
    await a.context().close();
    await b.context().close();
  }
});
