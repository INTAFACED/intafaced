import { test, expect } from '@playwright/test';
import { forgetSession, nextCode } from './identity-factors.mjs';
import {
  approveKyb,
  businessReadyPerson,
  openBusiness,
  refusedPayCalls,
  sentForReview,
  signInWithCode,
  verifiedBusiness,
} from './merchant.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';

// J-merchant-02, in the running app (docs/roadmap/journeys.json): get verified and go live. Tests titled
// "J-merchant-02 #<n>" prove a whole step; the others prove part of one and say which.
const J = 'J-merchant-02';

test(`${J} part of #2 sending the verification reference and INTAFACED's decision both show in the verification history`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mkh', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST History Ltd');
  const refused = refusedPayCalls(page);
  // Sends the reference from /pay/onboarding/verification, then the founder pair approves it.
  await verifiedBusiness(page, owner, merchantId);

  await page.goto('/pay/onboarding/verification');
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Verification history' }) });
  await expect(history).toContainText('In review to Approved');
  await expect(history).toContainText('Decided by INTAFACED');
  await expect(history).toContainText('Not sent to In review');
  await expect(history).toContainText('Sent by you');
  await expect(history.getByText('Nothing sent yet')).toHaveCount(0);
  expect(refused).toEqual([]);
});

test(`${J} part of #1 the owner reads the second-approval rule and turns it on and off again`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'msa', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Second Approval Ltd');
  // Changing a setting is a pay:write call, which a business holds once it is verified.
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/settings');
  const refused = refusedPayCalls(page);

  const rule = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Second approval', level: 2 }) });
  await expect(rule.getByRole('status')).toHaveText('Second approval is off.');
  await expect(rule).not.toContainText('We can’t read this setting.');
  await rule.getByRole('button', { name: 'Turn on second approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on second approval' }).click();
  await expect(rule.getByRole('status')).toHaveText('Second approval is on.');
  await page.reload();
  await expect(rule.getByRole('status')).toHaveText('Second approval is on.');
  await rule.getByRole('button', { name: 'Turn off second approval' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off second approval' }).click();
  await expect(rule.getByRole('status')).toHaveText('Second approval is off.');
  expect(refused).toEqual([]);
});

test(`${J} part of #1 a new owner adds the business address before verification, and setup counts the details as done`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mad', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Address Ltd');
  const refused = refusedPayCalls(page);
  await page.goto('/pay/onboarding');
  await expect(page.getByText('Your business details are missing: address.')).toBeVisible();

  await page.goto('/pay/settings');
  await page.getByLabel('Address line 1').fill('1 Test Street');
  await page.getByLabel('City').fill('Testville');
  await page.getByLabel('Postal code').fill('T3ST 1NG');
  await page.getByLabel('Country code').fill('GB');
  await page.getByLabel('Reason *').fill('Add our address');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('1 Test Street, Testville, T3ST 1NG, GB');
  await review.getByRole('button', { name: 'Save changes' }).click();
  const history = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Change history', level: 2 }) });
  await expect(history.getByRole('listitem')).toHaveCount(1);
  await expect(history).toContainText('Add our address');

  await page.goto('/pay/onboarding');
  await expect(page.getByText('What is left')).toBeVisible();
  await expect(page.getByText(/Your business details are missing/)).toHaveCount(0);
  await expect(page.getByText('Send your verification reference for review (step 2).')).toBeVisible();
  expect(refused).toEqual([]);
});

test(`${J} #1 the owner fills the business step and opens the account at the published starting fee; the business and the application draft are saved by the service and survive leaving, a fresh sign-in included`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mbd', '/pay/onboarding');

  await page.goto('/pay/onboarding/business');
  await page.getByLabel('Legal business name *').fill('TEST Draft Ltd');
  await page.getByLabel('Country code *').fill('DE');
  await page.getByLabel('Type of business *').fill('online shop');
  await page.getByLabel('Contact email *').fill(owner.email);
  // The stack publishes a TEST starting fee, so the first step opens the account instead of refusing it.
  await expect(page.getByText('Opening new accounts isn’t possible here')).toHaveCount(0);
  const created = page.waitForResponse((r) => r.url().includes('merchant.create') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create my account' }).click();
  const review = page.getByRole('dialog');
  await expect(review.locator('dt', { hasText: 'Starting fee' }).locator('+ dd')).not.toHaveText(/^(Not published)?$/);
  await review.getByRole('button', { name: 'Create my account' }).click();
  const sent = await (await created).json();
  const merchantId = (Array.isArray(sent) ? sent[0] : sent).result.data.id;
  await expect(page.getByText('Your merchant account exists.')).toBeVisible();
  // Before the account exists the person holds no business grant, so the check starts here, as in the steps below.
  const refused = refusedPayCalls(page);

  const app = await startApplication(page, 'Private company');
  const company = app.getByRole('region', { name: 'Company details' });
  await company.getByLabel('Registered legal name *').fill('TEST Draft Ltd');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(company.getByRole('status')).toHaveText('Saved.');
  await expect(company).toContainText('Saved, not finished');

  // Leaving: back to the personal home, then a sign-out with the browser's storage cleared, then a fresh sign-in.
  // Calls a signed-out page makes are refused, as they should be, so the check is split around the sign-out.
  await page.goto('/home');
  expect(refused).toEqual([]);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/onboarding/business');
  const refusedAfter = refusedPayCalls(page);
  await expect(page.getByTestId('pp-mono').filter({ hasText: merchantId })).toBeVisible();
  await page.goto('/pay/onboarding/verification');
  const back = app.getByRole('region', { name: 'Company details' });
  await expect(back).toContainText('Saved, not finished');
  await expect(back.getByLabel('Registered legal name *')).toHaveValue('TEST Draft Ltd');
  await expect(app.getByRole('list', { name: 'Still needed' })).toContainText('Company details');
  expect(refusedAfter).toEqual([]);
});

test(`${J} part of #6 the owner reads the published merchant terms and accepts them before going live`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mtc', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Terms Ltd');
  const refused = refusedPayCalls(page);

  await page.goto('/pay/onboarding');
  await expect(page.getByText('Accept the terms of service (step 3).')).toBeVisible();
  await page.goto('/pay/onboarding/go-live');
  const terms = page.getByTestId('onboarding-terms');
  await expect(terms.getByRole('link', { name: 'Read the terms (version TEST-merchant-terms-1)' })).toHaveAttribute(
    'href',
    'https://terms.example/TEST-merchant-terms-1',
  );
  await expect(page.getByText('No terms of service to accept')).toHaveCount(0);
  await terms.getByRole('button', { name: 'Accept the terms' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Accept the terms' }).click();
  await expect(terms.getByRole('status')).toContainText('Version TEST-merchant-terms-1 accepted.');
  await page.reload();
  await expect(terms.getByRole('status')).toContainText('Version TEST-merchant-terms-1 accepted.');
  await page.goto('/pay/onboarding');
  await expect(page.getByText('Accept the terms of service (step 3).')).toHaveCount(0);
  expect(refused).toEqual([]);
});

test(`${J} #5 the verified owner saves where payouts go, confirming it with a fresh authenticator code`, async ({ page }) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mpd', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Payout Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/onboarding/go-live');
  const refused = refusedPayCalls(page);

  const wallet = `0x${'ab'.repeat(20)}`;
  await page.getByLabel('Wallet address *').fill(wallet);
  await page.getByRole('button', { name: 'Save destination' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText(wallet);
  const code = review.getByLabel('6-digit code from your authenticator app *');
  await code.fill('123456');
  await review.getByRole('button', { name: 'Save destination' }).click();
  await expect(review.getByText("That code didn't match. Check your authenticator app and try again.")).toBeVisible();
  await expect(code).toHaveValue('');
  const fresh = await nextCode(owner.totp, owner.secret, owner.step);
  owner.step = fresh.step;
  await code.fill(fresh.code);
  await review.getByRole('button', { name: 'Save destination' }).click();
  await expect(page.getByText('Destination saved.', { exact: true })).toBeVisible();
  // The code is good once: the field is empty again.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.reload();
  const standing = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Before you go live', level: 2 }) });
  await expect(standing).toContainText('DestinationSaved');
  await page.goto('/pay/payouts/destinations');
  await expect(page.getByText('No destinations yet')).toHaveCount(0);
  expect(refused).toEqual([]);
});

/** Step 2's business application on the verification page, started for one type and country. */
async function startApplication(page, typeLabel, country = 'DE') {
  await page.goto('/pay/onboarding/verification');
  const app = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Business application' }) });
  await app.getByLabel('Legal entity type *').selectOption({ label: typeLabel });
  await app.getByLabel('Country the business is registered in *').selectOption(country);
  await app.getByRole('button', { name: 'Start the application' }).click();
  await expect(app.getByText('Pending', { exact: true })).toBeVisible();
  return app;
}

test(`${J} #2 the owner chooses the legal entity type; changing it returns the application to Pending and lists what is still needed with a due date`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mkt', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Entity Ltd');
  const refused = refusedPayCalls(page);

  const app = await startApplication(page, 'Private company');
  const needed = app.getByRole('list', { name: 'Still needed' });
  await expect(needed).toContainText('Company details');
  await expect(needed).toContainText('People behind the business');
  await expect(needed).toContainText('Documents: Test certificate of incorporation, Test proof of address');
  await expect(needed).toContainText('Questions');
  // The stack's TEST due date is 30 days from the start.
  await expect(app.locator('dt', { hasText: 'Due by' }).locator('+ dd time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);

  const company = app.getByRole('region', { name: 'Company details' });
  await company.getByLabel('Registered legal name *').fill('TEST Entity Ltd');
  await company.getByLabel('Registered address *').fill('1 Test Street, Berlin');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(company.getByRole('status')).toHaveText('Saved. This part is done.');
  await expect(needed).not.toContainText('Company details');

  const change = app.getByRole('region', { name: 'Change the legal entity type' });
  await change.getByLabel('Legal entity type *').selectOption({ label: 'Sole trader' });
  await change.getByRole('button', { name: 'Change type' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Change type' }).click();
  await expect(change.getByRole('status').filter({ hasText: 'Type changed.' })).toHaveText(
    'Type changed. Fill in each part again for the new type.',
  );
  await expect(app.getByText('Pending', { exact: true })).toBeVisible();
  await expect(needed).toContainText('Company details');
  await expect(needed).toContainText('Documents: Test proof of identity, Test proof of address');
  await expect(app.getByRole('region', { name: 'Company details' })).toContainText('Not started');
  await expect(app.getByRole('region', { name: 'People behind the business' }).getByLabel('Role *')).toHaveValue('test_proprietor');

  await page.reload();
  await expect(app.locator('dd', { hasText: 'Sole trader' })).toBeVisible();
  await expect(needed).toContainText('Test proof of identity');
  expect(refused).toEqual([]);
});

test(`${J} #3 the owner adds the people and documents a sole trader is asked for; a file over the limit or of a wrong type is refused before it is sent; each row reads Pending, then Verified or Invalid with the reason once INTAFACED reviews it, and an Invalid one takes a new file`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mdc', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Documents Ltd');
  const refused = refusedPayCalls(page);
  const uploads = [];
  page.on('request', (req) => req.url().includes('kyb.documents.upload') && uploads.push(req.url()));

  const app = await startApplication(page, 'Sole trader');
  const company = app.getByRole('region', { name: 'Company details' });
  await company.getByLabel('Registered legal name *').fill('TEST Documents Ltd');
  await company.getByLabel('Registered address *').fill('2 Test Street, Berlin');
  await company.getByRole('button', { name: 'Save' }).click();
  await expect(company.getByRole('status')).toHaveText('Saved. This part is done.');

  const people = app.getByRole('region', { name: 'People behind the business' });
  await people.getByLabel('Full legal name *').fill('TEST Proprietor');
  await people.getByLabel('Date of birth *').fill('1980-01-02');
  await people.getByLabel('Nationality (2-letter country code) *').fill('DE');
  await people.getByRole('button', { name: 'Save' }).click();
  await expect(people.getByRole('status')).toHaveText('Saved. This part is done.');

  const questions = app.getByRole('region', { name: 'Questions' });
  await questions.getByLabel('Test nature of business *').fill('TEST online sales of printed books');
  await questions.getByRole('button', { name: 'Save' }).click();
  await expect(questions.getByRole('status')).toHaveText('Saved. This part is done.');

  const docs = app.getByRole('region', { name: 'Documents', exact: true });
  await expect(docs).toContainText('Files up to 1.0 MB. Accepted: PDF, PNG.');
  await expect(docs).toContainText('The automatic document check isn’t connected');
  const identity = docs.getByRole('row', { name: /Test proof of identity/ });
  await expect(identity).toContainText('Needed');
  const pick = identity.getByLabel('Choose a file for Test proof of identity');
  await pick.setInputFiles({ name: 'too-big.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
  await expect(identity.getByRole('alert')).toHaveText('This file is 2.0 MB. The limit is 1.0 MB. Choose a smaller file.');
  await expect(identity.getByRole('button', { name: 'Send' })).toBeDisabled();
  await pick.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('TEST notes') });
  await expect(identity.getByRole('alert')).toHaveText('This kind of file isn’t accepted. Accepted: PDF, PNG.');
  await expect(identity.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(uploads).toEqual([]);

  const pdf = (text) => Buffer.from(`%PDF-1.4\n% TEST ${text}\n%%EOF\n`);
  await pick.setInputFiles({ name: 'identity.pdf', mimeType: 'application/pdf', buffer: pdf('identity') });
  await identity.getByRole('button', { name: 'Send' }).click();
  await expect(docs.getByRole('row', { name: /Test proof of identity/ })).toContainText('Pending');
  const address = docs.getByRole('row', { name: /Test proof of address/ });
  await address
    .getByLabel('Choose a file for Test proof of address')
    .setInputFiles({ name: 'address.png', mimeType: 'image/png', buffer: Buffer.from('TEST png') });
  await address.getByRole('button', { name: 'Send' }).click();
  await expect(docs.getByRole('row', { name: /Test proof of address/ })).toContainText('Pending');
  expect(uploads).toHaveLength(2);

  await docs.getByRole('button', { name: 'Confirm documents' }).click();
  await expect(docs.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText('Saved. This part is done.');
  await expect(app.getByText('Ready to send', { exact: true })).toBeVisible();
  await page.reload();
  await expect(app.getByText('Ready to send', { exact: true })).toBeVisible();
  await expect(
    app.getByRole('region', { name: 'Documents', exact: true }).getByRole('row', { name: /Test proof of identity/ }),
  ).toContainText('Pending');

  await app.getByRole('button', { name: 'Send application for review' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send application for review' }).click();
  await expect(app.getByText('Sent for review', { exact: true })).toBeVisible();
  await expect(app).toContainText('INTAFACED is reviewing your application');
  await expect(page.getByText('INTAFACED is reviewing it')).toBeVisible();
  await expect(app.getByRole('region', { name: 'Documents', exact: true }).locator('input[type=file]')).toHaveCount(0);

  // INTAFACED's compliance reviewer opens each file in the founder console and gives it a verdict.
  const desk = await (await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } })).newPage();
  await founderSignIn(desk, 'a');
  await desk.goto(`/merchants/${merchantId}?tab=verification`);
  const review = desk.locator('#verification');
  await expect(review).toContainText('Sent for review');
  const opened = desk.context().waitForEvent('page');
  await review.getByRole('button', { name: 'Open the file for Test proof of identity' }).click();
  // The tab opens on the click and then shows the file's bytes.
  const tab = await opened;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await review.getByRole('button', { name: 'Mark Test proof of identity Verified' }).click();
  await expect(review.getByRole('button', { name: 'Mark Test proof of identity Verified' })).toHaveCount(0);
  await expect(review.getByRole('row', { name: /Test proof of identity/ })).toContainText('Reviewed by');
  const addressRow = review.getByRole('row', { name: /Test proof of address/ });
  await expect(addressRow.getByRole('button', { name: 'Mark Test proof of address Invalid' })).toBeDisabled();
  await addressRow.getByLabel('Reason, if Invalid (the merchant reads it)').fill('TEST the address is cut off at the bottom');
  await addressRow.getByRole('button', { name: 'Mark Test proof of address Invalid' }).click();
  await expect(addressRow).toContainText('Reason given: TEST the address is cut off at the bottom');
  await desk.context().close();
  await page.reload();
  const reviewed = app.getByRole('region', { name: 'Documents', exact: true });
  await expect(reviewed.getByRole('row', { name: /Test proof of identity/ })).toContainText('Verified');
  const invalid = reviewed.getByRole('row', { name: /Test proof of address/ });
  await expect(invalid).toContainText('Invalid');
  await expect(invalid).toContainText('Reason: TEST the address is cut off at the bottom');

  // Still under review, the owner answers Invalid with a new file for that document only.
  await expect(app).toContainText('INTAFACED marked a document Invalid. Send a new file for it under Documents');
  await expect(reviewed.locator('input[type=file]')).toHaveCount(1);
  await invalid
    .getByLabel('Choose a file for Test proof of address')
    .setInputFiles({ name: 'address-whole.png', mimeType: 'image/png', buffer: Buffer.from('TEST png, the whole page') });
  await invalid.getByRole('button', { name: 'Send' }).click();
  await expect(reviewed.getByRole('row', { name: /Test proof of address/ })).toContainText('Pending');
  await expect(reviewed.locator('input[type=file]')).toHaveCount(0);
  expect(uploads).toHaveLength(3);
  expect(refused).toEqual([]);
});

test(`${J} #4 the owner answers an information request from the reviewer: a banner when one is past due, an infected file refused, and a closed request shows who closed it`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const owner = await businessReadyPerson(page, 'mir', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Requests Ltd');
  const answers = [];
  page.on('request', (req) => req.url().includes('kyb.requests.answer') && answers.push(req.url()));

  // INTAFACED's compliance reviewer asks for two things in the founder console: one due in ten days, one in two minutes.
  const desk = await (await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } })).newPage();
  await founderSignIn(desk, 'a');
  await desk.goto(`/merchants/${merchantId}?tab=verification`);
  const asks = desk.locator('#information-requests');
  await expect(asks).toContainText('No information requests');
  const localTime = (ms) => {
    const d = new Date(Date.now() + ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const STATEMENT = 'TEST send a bank statement from the last three months';
  const BILL = 'TEST send a utility bill for the business address';
  await asks.getByLabel('What the merchant should send (they read it as written)').fill(STATEMENT);
  await asks.getByLabel('Due by (your local time)').fill(localTime(10 * 86_400_000));
  await asks.getByRole('button', { name: 'Send request' }).click();
  await expect(asks.getByTestId('kyb-request').filter({ hasText: STATEMENT })).toContainText('Open');
  await asks.getByLabel('What the merchant should send (they read it as written)').fill(BILL);
  await asks.getByLabel('Due by (your local time)').fill(localTime(2 * 60_000));
  await asks.getByRole('button', { name: 'Send request' }).click();
  await expect(asks.getByTestId('kyb-request').filter({ hasText: BILL })).toBeVisible();

  // The owner reads both on the Compliance page and answers the statement request.
  await page.goto('/pay/compliance');
  const requests = page.getByRole('list', { name: 'Information requests' });
  const statement = requests.getByRole('listitem', { name: STATEMENT });
  await expect(statement).toContainText('Open');
  await expect(statement).toContainText('Every file is checked for malware before it is kept.');
  await expect(requests.getByRole('listitem', { name: BILL })).toBeVisible();

  // An infected file (the industry-standard EICAR test string) is refused and nothing of it is kept.
  const eicar = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');
  await statement.getByLabel('Your note').fill('TEST the statement is attached');
  await statement.getByLabel('Choose a file to send with your answer').setInputFiles({
    name: 'statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from(eicar),
  });
  await statement.getByRole('button', { name: 'Send answer' }).click();
  await expect(statement.getByRole('alert')).toHaveText(
    'The malware check found a threat in this file, so it wasn’t kept. Send a clean copy.',
  );
  await expect(statement).toContainText('Open');

  await statement.getByLabel('Choose a file to send with your answer').setInputFiles({
    name: 'statement.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% TEST bank statement\n%%EOF\n'),
  });
  await statement.getByRole('button', { name: 'Send answer' }).click();
  await expect(statement).toContainText('Answered');
  await expect(statement).toContainText('passed the malware check');
  expect(answers).toHaveLength(2);

  // The reviewer opens the file and closes the request with a note.
  await desk.reload();
  const asked = asks.getByTestId('kyb-request').filter({ hasText: STATEMENT });
  await expect(asked).toContainText('Merchant’s note: TEST the statement is attached');
  const opened = desk.context().waitForEvent('page');
  await asked.getByRole('button', { name: /^Open the file sent for request/ }).click();
  const tab = await opened;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await asked.getByLabel('Closing note (the merchant reads it)').fill('TEST statement received, thank you');
  await asked.getByRole('button', { name: /^Close request/ }).click();
  await expect(asked).toContainText('Closed by');
  await expect(asked).toContainText('TEST statement received, thank you');
  await desk.context().close();

  await page.reload();
  const closed = page.getByRole('list', { name: 'Information requests' }).getByRole('listitem', { name: STATEMENT });
  await expect(closed).toContainText('Closed by INTAFACED reviewer');
  await expect(closed).toContainText('TEST statement received, thank you');
  await expect(closed.getByRole('button', { name: 'Send answer' })).toHaveCount(0);

  // Once the bill request's due date passes unanswered, the page warns about it.
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('alert').filter({ hasText: 'past its due date' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 200_000, intervals: [10_000] });
  await expect(page.getByRole('listitem', { name: BILL })).toContainText('Past due');
});

test(`${J} #7 the owner chooses the business category and reads its class rule; "no rule set" while the table is empty, and a high-risk category shows its reserve and extra documents`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mbc', '/pay/onboarding');
  await openBusiness(page, owner, 'TEST Category Ltd');
  const refused = refusedPayCalls(page);
  await page.goto('/pay/compliance');
  const section = page
    .locator('section[data-testid="pay-section"]')
    .filter({ has: page.getByRole('heading', { name: 'Business category' }) });
  const all = section.getByRole('list', { name: 'Every category' });
  await expect(section.getByTestId('category-no-rule').or(all)).toBeVisible();
  // A shared stack may already hold categories from an earlier run; a fresh one has none and says so.
  if (await section.getByTestId('category-no-rule').isVisible()) {
    await expect(section).toContainText('No rule set');
    await expect(section.getByLabel('Your business category')).toHaveCount(0);
  }

  // Founder A adds a high-risk (restricted) TEST category; founder B approves exactly that change in their own sign-in.
  const tag = Date.now().toString(36);
  const LABEL = `TEST gaming ${tag}`;
  const contextA = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const a = await contextA.newPage();
  await founderSignIn(a, 'a');
  await a.goto('/merchants/categories');
  const editor = a.getByRole('group', { name: 'Change the category table' });
  await editor.getByRole('button', { name: 'Add a category' }).click();
  await editor.getByLabel('Key (lowercase words joined by hyphens; it never changes)').fill(`test-gaming-${tag}`);
  await editor.getByLabel('Name the business reads').fill(LABEL);
  await editor.getByLabel('Class').selectOption('restricted');
  await editor.getByLabel('Reserve percent (blank: not set)').fill('5.00');
  await editor.getByLabel('Reserve held for, in days (blank: not set)').fill('90');
  await editor.getByLabel('Extra documents the business sends (one per line)').fill('TEST gaming licence');
  await editor.getByLabel('Why (kept in the history)').fill('TEST add a high-risk category');
  await editor.getByRole('button', { name: 'Review the change' }).click();
  await expect(editor.getByTestId('category-review')).toContainText(LABEL);
  await editor.getByRole('button', { name: 'Ask the other founder to approve' }).click();
  const handoff = await editor.getByLabel('Request for the other founder').inputValue();

  const contextB = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
  const b = await contextB.newPage();
  await founderSignIn(b, 'b');
  await b.goto('/merchants/categories');
  const approve = b.getByRole('group', { name: 'Approve a category change' });
  await approve.getByLabel('Request from the other founder').fill(handoff);
  await expect(approve).toContainText(LABEL);
  await approve.getByRole('button', { name: 'Approve this category change' }).click();
  await expect(approve).toContainText('Approved');
  await contextB.close();

  await editor.getByRole('button', { name: 'Save the change' }).click();
  await expect(editor).toContainText(`${LABEL} is in the table`);
  await a.reload();
  await expect(a.getByTestId('category-table')).toContainText(LABEL);
  await expect(a.getByTestId('category-event').filter({ hasText: LABEL })).toContainText('TEST add a high-risk category');

  // And a standard TEST category (OWNER 108: cards, crypto and bank transfer), once per stack, so every later journey's
  // business takes every method whichever journeys ran before it (merchant.mjs chooseTakenCategory picks it first).
  const table = a.getByTestId('category-table');
  await expect(table).toContainText(LABEL);
  if (!((await table.textContent()) ?? '').includes('test-standard-shop')) {
    await editor.getByRole('button', { name: 'Add a category' }).click();
    await editor.getByLabel('Key (lowercase words joined by hyphens; it never changes)').fill('test-standard-shop');
    await editor.getByLabel('Name the business reads').fill('TEST Standard shop');
    await editor.getByLabel('Class').selectOption('standard');
    await editor.getByLabel('Why (kept in the history)').fill('TEST add a standard category');
    await editor.getByRole('button', { name: 'Review the change' }).click();
    await expect(editor.getByTestId('category-review')).toContainText('TEST Standard shop');
    await editor.getByRole('button', { name: 'Ask the other founder to approve' }).click();
    const standardHandoff = await editor.getByLabel('Request for the other founder').inputValue();
    const contextB2 = await browser.newContext({ baseURL: ADMIN, viewport: { width: 1440, height: 1000 } });
    const b2 = await contextB2.newPage();
    await founderSignIn(b2, 'b');
    await b2.goto('/merchants/categories');
    const approve2 = b2.getByRole('group', { name: 'Approve a category change' });
    await approve2.getByLabel('Request from the other founder').fill(standardHandoff);
    await expect(approve2).toContainText('TEST Standard shop');
    await approve2.getByRole('button', { name: 'Approve this category change' }).click();
    await expect(approve2).toContainText('Approved');
    await contextB2.close();
    await editor.getByRole('button', { name: 'Save the change' }).click();
    await expect(editor).toContainText('TEST Standard shop is in the table');
  }
  await contextA.close();

  // The owner reads the table with the class rule, reserve and documents, and picks the new category.
  await page.reload();
  const item = section.getByRole('list', { name: 'Every category' }).getByRole('listitem', { name: LABEL });
  await expect(item).toContainText('High risk');
  await expect(item).toContainText('No card payments (crypto and bank transfer only), extra documents and a reserve.');
  await expect(item).toContainText('5% of payments, held for 90 days');
  await expect(item).toContainText('TEST gaming licence');
  await expect(section).toContainText('You haven’t chosen a category yet');
  await section.getByLabel('Your business category').selectOption({ label: LABEL });
  await section.getByRole('button', { name: 'Save category' }).click();
  await expect(section.getByText('Your category was saved.')).toBeVisible();
  const chosen = section.getByTestId('category-chosen');
  await expect(chosen).toContainText('High risk');
  await expect(chosen).toContainText('5% of payments, held for 90 days');
  await page.reload();
  await expect(section.getByTestId('category-chosen')).toContainText('TEST gaming licence');
  expect(refused).toEqual([]);
});

test(`${J} #6 the owner reads the verification history and the activation state: the history only grows, activation reads unconfirmed until svc-pay records one, and nothing reads as a screening clearance`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await businessReadyPerson(page, 'mav', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Activation Ltd');
  const refused = refusedPayCalls(page);
  const activation = page.getByTestId('pp-activation');
  const history = page.getByRole('list', { name: 'Verification history' });
  const entries = async () =>
    history.getByRole('listitem').evaluateAll((items) =>
      items.map((li) => ({
        title: li.querySelector('strong')?.textContent ?? '',
        at: li.querySelector('time')?.getAttribute('datetime') ?? '',
      })),
    );
  const noClearance = async () =>
    expect(page.locator('main')).not.toContainText(/screening (passed|cleared|complete)|(passed|cleared) screening/i);

  // A new business: nothing sent, activation unconfirmed because svc-pay holds no activation record.
  await page.goto('/pay/compliance');
  await expect(activation).toContainText('Unconfirmed');
  await expect(activation).not.toContainText('Activated');
  await expect(page.getByText('INTAFACED has no recorded activation for this business.')).toBeVisible();
  await expect(page.getByText('No verification history yet')).toBeVisible();
  await noClearance();

  // Sent for review: one entry, by the owner.
  await sentForReview(page, owner);
  await page.goto('/pay/compliance');
  await expect(history.getByRole('listitem')).toHaveCount(1);
  const sent = await entries();
  expect(sent).toEqual([{ title: 'Verification changed: Not sent → In review', at: expect.stringMatching(/^\d{4}-/) }]);
  await expect(history).toContainText('Changed by your merchant account');

  // INTAFACED approves it: a new entry on top, the earlier one exactly as it was, times in order.
  approveKyb(merchantId);
  await page.reload();
  await expect(history.getByRole('listitem')).toHaveCount(2);
  const decided = await entries();
  expect(decided[0].title).toBe('Verification changed: In review → Approved');
  expect(decided[1]).toEqual(sent[0]);
  expect(Date.parse(decided[0].at)).toBeGreaterThanOrEqual(Date.parse(decided[1].at));
  await expect(history.getByRole('listitem').first()).toContainText('Changed by INTAFACED');

  // An approved verification is not an activation: svc-pay records none on a KYB decision, so it stays unconfirmed.
  await expect(page.getByTestId('pp-facts')).toContainText('Approved');
  await expect(activation).toContainText('Unconfirmed');
  await expect(activation).not.toContainText('Confirmed');
  await expect(page.getByText('It is not a screening result.')).toBeVisible();
  await noClearance();
  expect(refused).toEqual([]);
});
