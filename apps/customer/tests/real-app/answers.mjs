import { expect } from './journey.mjs';

/** The body of a service answer that must be 200, with the start of the body in the failure when it is not. */
export function body200(res) {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
}

/** The tRPC error a refused call answers, from a plain or a batched reply, with or without a json envelope. */
export function trpcError(body) {
  const one = Array.isArray(body) ? body[0] : body;
  const error = one?.error;
  return error?.json ?? error;
}
