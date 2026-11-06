/**
 * The SBE L2 tape's consumers, as this adapter holds them (J-cex-spot-20 #3, SP-order-02): one row per open
 * `format=sbe` depth socket, with the last tape sequence it was sent. Market data only: no account, no balance, no
 * Greeks. The id is this process's own counter, so it names no customer and no address.
 */
import type { FastifyInstance } from 'fastify';
import { verifyServiceHeaders } from '@intafaced/contracts';

export interface SbeConsumerRow {
  readonly id: string;
  readonly marketId: string;
  readonly connectedAt: string;
  readonly framesSent: number;
  /** The tape sequence of the last frame sent; null until one is. */
  readonly lastSequence: string | null;
}

export interface SbeConsumerHandle {
  readonly id: string;
  /** One encoded frame went out carrying this tape sequence. */
  sent(sequence: string): void;
  remove(): void;
}

export class SbeConsumers {
  private next = 0;
  private readonly rows = new Map<string, { marketId: string; connectedAt: string; framesSent: number; lastSequence: string | null }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  add(marketId: string): SbeConsumerHandle {
    this.next += 1;
    const id = `sbe-${this.next}`;
    const row = { marketId, connectedAt: this.now().toISOString(), framesSent: 0, lastSequence: null as string | null };
    this.rows.set(id, row);
    return {
      id,
      sent: (sequence) => {
        row.framesSent += 1;
        row.lastSequence = sequence;
      },
      remove: () => {
        this.rows.delete(id);
      },
    };
  }

  list(): SbeConsumerRow[] {
    return [...this.rows.entries()].map(([id, r]) => ({ id, ...r }));
  }
}

export const SBE_STATUS_PATH = '/internal/sbe/consumers';
export const SBE_STATUS_SECRET_ENV = 'WS_STATUS_READ_SECRET';
/** The only caller that may read the consumer list: the founder console's door. */
const CALLER = 'svc-edge';

/**
 * `GET /internal/sbe/consumers`, signed as svc-edge with the dedicated read key `WS_STATUS_READ_SECRET` (svc-ws holds
 * no fleet secret). Blank key: `ws_status_unconfigured`, and the tape itself is untouched.
 */
export function registerSbeStatusDoor(
  app: FastifyInstance,
  options: {
    readonly consumers: SbeConsumers;
    readonly secret: string | undefined;
    readonly codecLinked: () => boolean;
    readonly now?: () => Date;
  },
): void {
  const now = options.now ?? (() => new Date());
  app.get(SBE_STATUS_PATH, async (req, reply) => {
    const secret = options.secret;
    if (!secret) {
      return reply.code(503).send({
        ok: false,
        error: {
          code: 'ws_status_unconfigured',
          message: `${SBE_STATUS_SECRET_ENV} is blank; svc-ws does not list its consumers to an unsigned caller`,
        },
      });
    }
    const auth = verifyServiceHeaders(req.headers, secret, {
      mode: 'require',
      rawBody: { retained: true, bytes: Buffer.alloc(0) },
      now: now(),
    });
    if (!auth.service) {
      return reply
        .code(401)
        .send({ ok: false, error: { code: 'unauthenticated', message: `service credentials required (${auth.rejected})` } });
    }
    if (auth.service !== CALLER) {
      return reply.code(403).send({ ok: false, error: { code: 'forbidden', message: 'the SBE consumer list is read by svc-edge only' } });
    }
    return reply.send({
      service: 'svc-ws',
      codecLinked: options.codecLinked(),
      consumers: options.consumers.list(),
      asOf: now().toISOString(),
    });
  });
}
