// `clause()` and `expectRefusal()`, version 1: for new and rewritten journey tests.
//
// Frozen once a journey uses it (tooling/scripts/journey-clauses-v1.mjs says why): make a change in clauses-v2.mjs.
// Don't import this into a test whose steps are already proven: the reads of those steps judged the test without it.
//
//   test('J-x-01 #3 …', async ({ page }) => {
//     await clause('the order shows as resting, with its limit price', async () => { … });
//     await clause('or, when the market is closed, the typed refusal and nothing posted', async () => {
//       await expectRefusal(() => placeOrder(account, order), {
//         status: 409,
//         code: 'trade.market_closed',
//         unchanged: () => readBalances(account),
//       });
//     });
//   });
//
// One `clause()` for each clause of the step's words, and one for each `or` branch, so the report and a proof reader
// see which assertion proves which words. `expectRefusal` pins the exact status and typed code and, with `unchanged`,
// reads the state before and after the request and expects them equal.
import { expect, test } from './journey.mjs';
import { checkExpectation, clauseTitle, readResponse, refusalProblems } from '../../../../tooling/scripts/journey-clauses-v1.mjs';

/** One clause of the step's words, as its own step in the report. */
export function clause(words, body) {
  const title = clauseTitle(words);
  if (typeof body !== 'function') throw new TypeError(`${title}: give the assertions as a function`);
  return test.step(title, body);
}

/**
 * A typed refusal. `res` is the response (a Playwright APIResponse, a fetch Response or `{ status, body }`), or a
 * function that sends the request; with `unchanged` it must be the function, so the state can be read before it.
 * Returns the `{ status, body }` it read.
 */
export async function expectRefusal(res, { status, code, unchanged } = {}) {
  checkExpectation({ status, code });
  let before;
  if (unchanged !== undefined) {
    if (typeof unchanged !== 'function') throw new TypeError('expectRefusal: `unchanged` reads the state, so it is a function');
    if (typeof res !== 'function')
      throw new TypeError('expectRefusal: with `unchanged`, pass the request as a function, so the state is read before it');
    before = await unchanged();
  }
  const got = await readResponse(typeof res === 'function' ? await res() : res);
  expect(refusalProblems(got, { status, code }), `the refusal ${status} ${code}`).toEqual([]);
  if (unchanged !== undefined) expect(await unchanged(), `nothing moved on the refusal ${code}`).toEqual(before);
  return got;
}
