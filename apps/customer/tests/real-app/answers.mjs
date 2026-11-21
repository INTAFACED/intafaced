import { expect } from './journey.mjs';

/** The body of a service answer that must be 200, with the start of the body in the failure when it is not. */
export function body200(res) {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
}
