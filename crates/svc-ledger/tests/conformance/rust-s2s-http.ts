/**
 * `./s2s-http.js` for the TypeScript database tests run against the Rust door (`vitest.config.mts`): everything as it
 * is, except `handleS2sPost`, which sends the body to the Rust binary's `POST /trpc/post` over HTTP and answers what
 * it answered, a refusal rebuilt as the HTTP client rebuilds it (`rehydrateLedgerHttpError`).
 *
 * The caller the test names is the one the door proves: `bound` is signed with that service's key (the keyed door);
 * `legacy` and no caller at all go under the shared secret to the door with no keys. A direct call (no caller) skips
 * the caller binding in TypeScript; under the shared secret with no keys configured the binding only counts, so it
 * refuses nothing either.
 */
import { rehydrateLedgerHttpError } from '../../../../packages/ledger-client/dist/index.js';
import { DIRECT } from './door-client.ts';
import type { PostCaller } from '../../../../packages/ledger-client/src/gate/caller-judge.ts';
import { currentRustBook } from './rust-db.ts';
import { signerFor } from './rust-door.ts';

export * from '../../../../services/svc-ledger/src/s2s-http.ts';

export async function handleS2sPost(_ledger: unknown, body: unknown, caller?: PostCaller, binding?: unknown) {
  if (binding !== undefined) throw new Error('binding options are the TypeScript door’s; the Rust door reads its own env');
  const book = currentRustBook();
  const keyed = caller?.kind === 'bound';
  const service = caller?.kind === 'bound' ? caller.service : caller?.kind === 'legacy' ? (caller.claimed ?? DIRECT) : DIRECT;
  const target = `${keyed ? book.keyed : book.plain}/trpc/post`;
  const payload = JSON.stringify(body);
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...signerFor(service, keyed)(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
    },
    body: payload,
  });
  const text = await response.text();
  if (!response.ok) throw rehydrateLedgerHttpError('/trpc/post', response.status, text);
  return JSON.parse(text);
}
