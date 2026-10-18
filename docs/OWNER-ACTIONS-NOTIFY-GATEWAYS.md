# Owner actions — turning on email, push and SMS

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Who this is for:** Nitro. **How long:** about ten minutes per channel once you
have an account somewhere. **What is blocked until then:** every notification
that has to leave the platform, including margin calls.

Nothing in this list is a code change. The adapters are built, tested and
merged. They are waiting on two strings per channel.

---

## What is true right now

Users get every notification **in the app**. That part works and always has.

Email, push and SMS are **registered and refusing**. Each one records
`channel.not_configured` on the delivery row for every message it is asked to
send, and `GET /ready` names the variables it is missing. Nothing is silently
dropped, and nothing anywhere claims a message went out when it did not.

That is the honest state — it is not the finished one. A margin call that
reached only the in-app inbox reached a user who was not looking at the app.

---

## What you must supply — three channels, two strings each

Each channel is **one URL** and **one token**. Whatever answers that URL is your
choice, and it is deliberately not named anywhere in the code: swapping it later
is an environment change, not a release.

| Channel | Set this URL               | Set this token               | Sends to                  |
| ------- | -------------------------- | ---------------------------- | ------------------------- |
| Email   | `NOTIFY_EMAIL_GATEWAY_URL` | `NOTIFY_EMAIL_GATEWAY_TOKEN` | a mailbox                 |
| Push    | `NOTIFY_PUSH_GATEWAY_URL`  | `NOTIFY_PUSH_GATEWAY_TOKEN`  | a mobile-app device token |
| SMS     | `NOTIFY_SMS_GATEWAY_URL`   | `NOTIFY_SMS_GATEWAY_TOKEN`   | a phone number            |

**Where they go:** in `.env` next to the other secrets (copy the shapes from
`.env.example`), and in whatever holds production secrets when there is a
production. `docker-compose.apps.yml` already passes all six through, so the
container picks them up with no further edit.

**The token must be at least 16 characters.** That is not a style rule — a short
token on an endpoint that can send messages to your users is an open relay.

### One more line, and it is the important one

```
NOTIFY_REQUIRED_CHANNELS=email,sms
```

List the channels this deployment **depends on**. Anything listed must have both
of its variables set or **the service refuses to start** — the same posture as
`EDGE_PRINCIPAL_SECRET`. If you genuinely want in-app only, write `none`. In
staging and production, leaving this line out is itself a boot failure, because
"we decided in-app is enough" and "nobody thought about it" must not look the
same in a config file.

In dev and test, leave it out. Nothing is required and nothing needs a provider.

---

## What the thing behind the URL has to do

One HTTP endpoint. It receives:

```
POST <your url>
authorization: Bearer <your token>
idempotency-key: <notification id>:<channel>
content-type: application/json
```

…with a small JSON body carrying the recipient and the already-written message,
and it answers **any 2xx** if it accepted the message. Full field list per
channel: [`services/svc-notify/README.md`](../services/svc-notify/README.md).

You have two ways to get one:

1. **Buy it.** Most messaging providers offer an HTTP send API. If it takes a
   bearer token and a JSON body, point the URL straight at it.
2. **Run a small forwarder.** Fifty lines that receive the request above and call
   whichever provider SDK you chose. This is the usual answer when a provider's
   API does not match, and it is why no provider is baked into our code.

---

## Decisions that are yours, not ours

These are on the §8 list — an agent must not choose them:

- **Which provider**, in which jurisdictions, under what contract.
- **Whether SMS is a required channel.** It is the most expensive and the most
  reliable at reaching somebody who is not at a screen; whether margin calls
  depend on it is a product and risk call.
- **Any user-facing statement that a message was delivered.** See the next
  section — we can say a gateway accepted it, and nothing stronger.

---

## One thing to know before you rely on this

The strongest thing this service can ever say is **"a transport accepted the
message"**. It is recorded as `accepted_at`, and it is deliberately not called
`delivered_at`.

We do not receive delivery receipts from any of these channels. So "accepted"
does not mean the mail server took it, the handset was on, or a person read it.

This matters beyond notifications: svc-bank starts the liquidation grace clock
from a margin call's `notified_at`. A clock that decides whether somebody's
collateral is sold must not be started by a word that means less than the reader
thinks it means.

---

## How to check it worked

1. Start the stack. If a required channel is missing its pair, svc-notify will
   not start and will name the variable — that is the feature.
2. `GET /ready` on svc-notify lists every channel with `available: true|false`,
   `required: true|false`, and the variables any unavailable one still needs.
3. In the app, register an address on the channel. A six-digit code is sent
   **through that channel**, which proves the address and the gateway in one
   step. If the gateway is not wired you get `refused` and the reason, not a
   green tick.
