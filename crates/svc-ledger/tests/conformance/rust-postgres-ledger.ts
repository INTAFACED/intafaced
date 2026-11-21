/**
 * `./postgres-ledger.js` for the engine's database tests in the `engine-rust-door` project (`vitest.config.mts`): the
 * engine's reads as they are, on the book the Rust binary serves (`rust-db.ts`), and `post` sent to the binary's
 * `POST /trpc/post` with the real HTTP client under the shared secret. `idempotencyConflict: 'detect'` posts to the
 * detect-mode door, and each mismatch it logs is handed to `onIdempotencyMismatch` as the TypeScript engine hands it.
 */
import { createHttpLedgerClient, type LedgerTx, type PostRequest } from '../../../../packages/ledger-client/dist/index.js';
import { PostgresLedger as Engine, type PostgresLedgerOptions } from '../../../../services/svc-ledger/src/ledger/postgres-ledger.ts';
import { asClientError, DIRECT, refuseUnoffered } from './door-client.ts';
import { currentRustBook } from './rust-db.ts';
import { signerFor } from './rust-door.ts';

export * from '../../../../services/svc-ledger/src/ledger/postgres-ledger.ts';

export class PostgresLedger extends Engine {
  readonly #options: PostgresLedgerOptions;

  constructor(sql: ConstructorParameters<typeof Engine>[0], options: PostgresLedgerOptions = {}) {
    super(sql, options);
    refuseUnoffered(options);
    this.#options = options;
  }

  override async post(request: PostRequest): Promise<LedgerTx> {
    const book = currentRustBook();
    const detect = this.#options.idempotencyConflict === 'detect';
    const http = createHttpLedgerClient({
      baseUrl: detect ? book.detect : book.plain,
      sign: signerFor(DIRECT, false) as never,
      retries: 0,
    });
    const seen = book.mismatches.length;
    try {
      return await http.post(request);
    } catch (err) {
      throw asClientError(err);
    } finally {
      if (detect) {
        // The report is logged before the answer is sent, but the log pipe has no end-of-report event, and a retry
        // must be shown to report nothing.
        // oxlint-disable-next-line garden/no-real-clock-wait-in-tests -- proving nothing happens: no mismatch line follows a plain retry
        await new Promise((r) => setTimeout(r, 150));
        for (const m of book.mismatches.slice(seen)) {
          this.#options.onIdempotencyMismatch?.({
            idempotencyKey: String(m.idempotencyKey),
            module: String(m.module),
            reason: String(m.reason),
          });
        }
      }
    }
  }
}
