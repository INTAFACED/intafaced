/**
 * `./postgres-ledger.js` for the engine's database tests in the `engine-ts-door` project (`vitest.config.mts`): the
 * engine as it is, except `post`, which goes through the TypeScript `post` door (`handleS2sPost` over `LedgerService`,
 * custody on, under the shared secret) and answers as a caller sees it. The Rust run swaps in `rust-postgres-ledger.ts`;
 * `run.mjs` holds the two to one result.
 */
import { ledgerPostWire, parseLedgerPostAck, type LedgerTx, type PostRequest } from '../../../../packages/ledger-client/dist/index.js';
import { PostgresLedger as Engine, type PostgresLedgerOptions } from '../../../../services/svc-ledger/src/ledger/postgres-ledger.ts';
import { handleS2sPost } from '../../../../services/svc-ledger/src/s2s-http.ts';
import { LedgerService } from '../../../../services/svc-ledger/src/service.ts';
import { DIRECT, overTheWire, refuseUnoffered } from './door-client.ts';

export * from '../../../../services/svc-ledger/src/ledger/postgres-ledger.ts';

const NO_BUS = { publish: async () => ({}) } as never;

export class PostgresLedger extends Engine {
  readonly #door: LedgerService;

  constructor(sql: ConstructorParameters<typeof Engine>[0], options: PostgresLedgerOptions = {}) {
    super(sql, options);
    refuseUnoffered(options);
    this.#door = new LedgerService(sql, NO_BUS, {
      custodyLayer: 'on',
      ...(options.idempotencyConflict ? { idempotencyConflict: options.idempotencyConflict } : {}),
      ...(options.onIdempotencyMismatch ? { onIdempotencyMismatch: options.onIdempotencyMismatch } : {}),
    });
  }

  override async post(request: PostRequest): Promise<LedgerTx> {
    const wire = JSON.parse(JSON.stringify(ledgerPostWire(request)));
    let ack: unknown;
    try {
      ack = await handleS2sPost(this.#door, wire, { kind: 'legacy', claimed: DIRECT });
    } catch (err) {
      throw overTheWire(err);
    }
    return parseLedgerPostAck(request, JSON.parse(JSON.stringify(ack)));
  }
}
