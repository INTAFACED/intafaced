# packages/events — promise audit 2026-08-08

Tip: `32efec96`

The bus every service runs on. A false promise here is false in eleven services
at once, which is why this was the first target.

## Promises checked (9)

| Promise                                                                   | Where                   | Verdict                                |
| ------------------------------------------------------------------------- | ----------------------- | -------------------------------------- |
| A throwing handler is redelivered; a returning one is not                 | `jetstream-bus.ts` pump | VERIFIED (executed against real NATS)  |
| Redelivery stops at `max_deliver` rather than spinning                    | consumer config         | VERIFIED                               |
| "Never ack a message we failed to process"                                | catch block             | VERIFIED — the nak precedes everything |
| A bare `nak()` must not spend the budget in milliseconds                  | `nakBackoffMs`          | VERIFIED (#1042)                       |
| Publishes dedupe server-side on `msgID` inside the window                 | `publish`               | VERIFIED                               |
| Unknown fields are refused, never silently dropped                        | `EventSchemaDriftError` | VERIFIED                               |
| "Max redeliveries before the message goes to the **dead-letter subject**" | `bus.ts:33`             | **BROKEN** → #1059                     |
| Consumer config in this file is the config that runs                      | `subscribe`             | **BROKEN** → #1066                     |
| CI's NATS runs with JetStream on, like docker-compose                     | `ci.yml`                | VERIFIED                               |

## Broken, fixed here

**There is no dead-letter subject.** `grep -rni "dead.letter"` over the whole
repo returns exactly one hit: the promise itself. After `max_deliver` JetStream
simply stops redelivering — no subject, no row, no log; the NATS
`MAX_DELIVERIES` advisory exists and nothing subscribes to it. A margin call
that spent its entire budget left the same trace as one never published. The bus
now prints one structured `bus.message_abandoned` error on the last attempt,
naming subject, durable, producer and idempotency key, and the docstring says
what happens instead of what does not. **→ #1059**, confirmed in CI to have
actually executed against the real container rather than skipped.

**Changing the retry budget did nothing past the first boot.** `subscribe()`
called `consumers.add()` and stopped. A durable consumer lives in the server;
`add` on an existing one does not apply the config it is handed. So
`max_deliver` and `ack_wait` were whatever the first boot asked for,
permanently. `ensureStream` forty lines below has always done the opposite for
streams — catch "already in use", call `streams.update`. Streams reconciled;
consumers never did. That asymmetry was the bug, and it matters because
svc-notify's README bounds `NOTIFY_MAX_DELIVERY_ATTEMPTS` "at or below the bus
maxDeliver" — a bound against a number nobody was using. **→ #1066**

## Broken, parked — and why

**A non-`Error` throw from a handler takes the consumer down.** The pump does
`msg.nak(...)` then `if (!(err instanceof Error)) throw err`. That `throw`
escapes the `for await`; `pump` is a floating promise with no handler attached
until `unsubscribe()`, so it either ends the consumer loop or reaches Node's
unhandled-rejection path — and `/ready` keeps reporting `consumers:
subscriptions.length`, which does not change when a pump dies.
**Parked because it is not proven.** A handler throwing a non-`Error` is
reachable in principle and was found nowhere in this repo. The nak happens
first, so no message is acked either way. The right fix depends on which of the
two behaviours it actually produces, and answering that needs the real container
— which is now cheap, since this suite runs against it.

## Could NOT break, having tried

The ack/nak ordering — the nak is unconditional and precedes the rethrow, so
there is no path that acks a failure. Schema drift and version mismatch both
refuse rather than deliver a payload with a field removed, which is the defect
that cost an engineer a day. `ensureStream` reconciles subjects on every boot.
CI's NATS: I initially read the **stale main checkout** and nearly reported a
regression of #1040 — the tip's `ci.yml` correctly replaces the service
container with a `docker run` passing `--jetstream`, and the service container
is gone. **Read `origin/main`, never the working tree**; the checkout runs
~250 commits behind.

Not reached, and still open: backpressure and slow-consumer behaviour under a
full `consume()` buffer, and ordering guarantees under redelivery. Neither has a
written promise I could find, which is itself worth checking — an undocumented
guarantee is one every caller assumes differently.
