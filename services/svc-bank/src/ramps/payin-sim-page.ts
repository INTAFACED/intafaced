import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BankError } from '../errors.js';
import type { AddMoneyRequestView, AddMoneyService } from './add-money.js';
import type { OnrampPartner } from './payin-sim.js';

/**
 * THE PAY-IN STAND-IN'S PAYMENT PAGE, A TEST FIXTURE (J-bank-02 #3, #5; `ramps/payin-sim.ts`).
 *
 * Mounted only when `BANK_ONRAMP_PARTNER=payin-sim`, which refuses to boot outside dev or test. It stands in for the
 * partner's hosted page: it shows the payment the partner opened, labelled TEST, and on "Approve payment" records that
 * the payer approved it (the request becomes `pending`) and sends the payer back to the app. It moves no money and takes
 * no sign-in, as a partner's page is not the bank's: the credit is only ever the partner's signed "paid" job call.
 */

const id = z.object({ onrampId: z.string().uuid() }).strict();

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function page(partner: OnrampPartner, request: AddMoneyRequestView, returnUrl: string): string {
  const onramp = request.onramp;
  const pay = onramp ? `${onramp.payAmount} ${onramp.payCurrency}` : '';
  const action =
    request.status === 'opened'
      ? `<form method="post" action="/test/payin-sim/pay/${escape(request.requestId)}/approve"><button type="submit">Approve payment</button></form>`
      : `<p data-testid="payin-sim-state">This payment is already approved.</p>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>TEST payment page</title></head>
<body>
<main data-testid="payin-sim-page">
<h1>TEST payment page</h1>
<p data-testid="payin-sim-label">${escape(partner.label)}</p>
<p data-testid="payin-sim-amount">Pay ${escape(pay)} to add ${escape(request.amount)} ${escape(request.assetId)}</p>
${action}
<p><a href="${escape(returnUrl)}">Back without paying</a></p>
</main>
</body>
</html>`;
}

/** The stand-in's page and its approve button, on this service's own address. */
export function registerPayinSimPage(app: FastifyInstance, addMoney: Pick<AddMoneyService, 'opened' | 'approved'>, partner: OnrampPartner) {
  const returnOrigin = new URL(partner.returnUrl('00000000-0000-4000-8000-000000000000')).origin;
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // The approve form posts here and is redirected to the app, so the app's origin is a form target too.
    'content-security-policy': `default-src 'none'; form-action 'self' ${returnOrigin}; frame-ancestors 'none'`,
  };
  const refuse = (reply: { code: (n: number) => { send: (body: unknown) => unknown } }, err: unknown) => {
    if (!(err instanceof BankError)) throw err;
    const status = err.code === 'bank.add_money_request_missing' ? 404 : 409;
    return reply.code(status).send({ error: err.message, code: err.code });
  };
  void app.register(async (scope) => {
    // The approve button's form carries no fields: its body is read as nothing.
    scope.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}));
    scope.get('/test/payin-sim/pay/:onrampId', async (req, reply) => {
      const params = id.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'not a payment id', code: 'bank.validation_failed' });
      try {
        const { request, returnUrl } = await addMoney.opened(params.data.onrampId);
        return reply.headers(headers).send(page(partner, request, returnUrl));
      } catch (err) {
        return refuse(reply, err);
      }
    });
    scope.post('/test/payin-sim/pay/:onrampId/approve', async (req, reply) => {
      const params = id.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'not a payment id', code: 'bank.validation_failed' });
      try {
        const { returnUrl } = await addMoney.approved(params.data.onrampId);
        return reply.code(303).header('location', returnUrl).send();
      } catch (err) {
        return refuse(reply, err);
      }
    });
  });
}
