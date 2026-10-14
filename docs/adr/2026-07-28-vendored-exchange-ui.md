# The vendored exchange UI: what to take, and what to leave

**Status:** proposed  
**Status note:** Assessment. Decision is the repo owner's.
**Context:** direction given — _"the vendored exchange UI and app is better built so we use that ui, add all of our other features to it."_

---

## Where that instinct is right, and it is right

Ours: **7 `.tsx` files**, two pages, entirely static — no `use client`, no state, no fetch.
The vendored front-end: **57 `.vue` files**, roughly 30 screens across nine areas.

| area                                 | screens | do we have anything       |
| ------------------------------------ | ------- | ------------------------- |
| `uc` — user centre                   | 7       | no                        |
| `otc` — P2P fiat                     | 7       | svc-p2p exists; **no UI** |
| `cms` — content, help, announcements | 7       | no                        |
| `activity` — promos                  | 4       | no                        |
| `exchange` — spot trading            | 1       | static mockup             |
| `ctc`, `envelope`, `invite`, `index` | 4       | no                        |

That is a **product's worth of decisions already made** — flows, states, empty cases, error copy, the shape of a KYC journey, what an OTC dispute screen actually needs on it. That is expensive to invent and it is genuinely there. Taking it is the right call.

---

## Where "better built" does not survive contact

Facts, from `05_Web_Front/package.json` and the source:

|                | version                  | status                                                                 |
| -------------- | ------------------------ | ---------------------------------------------------------------------- |
| `vue`          | 2.5.2                    | **EOL Dec 2023** — no security patches, ever                           |
| `vue-resource` | 1.3.4                    | **retired by the Vue team in 2016**; they told people to stop using it |
| `iview`        | 3.1                      | dead; became View UI, this line is 2018                                |
| `jquery`       | 3.3.1                    | loaded _alongside_ Vue                                                 |
| `node-sass`    | 4.9.0                    | native build, supports up to Node 10; **we are on Node 22**            |
| build          | webpack 3 / babel-core 6 | 2017 toolchain                                                         |

Two more from reading it:

- **`Exchange.vue` is 2,872 lines in a single file** — markup, styles, STOMP subscription, order entry, depth rendering and business logic in one component. That is the trading screen, i.e. the money path.
- **`main.js` hardcodes `https://api.xxxx.com`** as the API host. Configuration is a source edit.
- Market data rides **STOMP over SockJS**, which is Spring's broker protocol. The UI's realtime layer is bound to the Java stack, not to a generic websocket.

`npm install` does not complete on this machine: `node-sass@4.9.0` cannot compile against Node 22's ABI.

**So it is more complete, and it is older.** Both are true, and they are not in tension — it is a finished 2018 product.

---

## What "use that UI" should mean

**Port the screens, not the stack.**

The value is the _product surface_: the flows, the layouts, the states, the copy. None of that is Vue-specific. What we would inherit by adopting the stack is a framework with no security patches, a retired HTTP client, jQuery, a build that will not run on a current Node, and a realtime layer welded to Spring.

The screens are the asset. Vue 2.5 is the packaging.

Concretely:

1. **Treat `05_Web_Front` as the design reference.** Screen by screen, it tells us what a finished version of each area looks like.
2. **Build them in `apps/web`** — Next 15 / React 19, which is already scaffolded and already carries the design tokens.
3. **Wire to our services**, not to `api.xxxx.com`, so the ledger stays the book of record and the security work from this week (`serviceProcedure`, purpose-keyed holds, ownership checks) still applies.
4. **Take the realtime layer from `@intafaced/market-data`** — snapshot + delta with gap detection — rather than STOMP. That code already exists and is tested to 22 cases including a 300-case property test.

This is the same answer as FinceptTerminal, for the same reason, and the reason held: **our own terminal, informed by theirs.**

---

## If the direction stands anyway

If the call is to run the Vue app as-is, these are the things that must happen first, and none are optional:

- Replace `node-sass` with `sass`, or it does not build at all.
- Replace `vue-resource` — it is retired and unmaintained; every API call goes through it.
- Move `api.xxxx.com` to configuration.
- Decide what happens to STOMP: either stand up a Spring STOMP broker for the UI, or rewrite the realtime layer.
- Accept Vue 2.5 with no security patches on the surface that handles logins and withdrawals, or budget the Vue 3 migration — which is a rewrite of 57 components, not an upgrade.

That is a real amount of work whose _output_ is a 2018 front-end. The same effort spent porting screens into `apps/web` produces the same screens on a stack that gets patched.

---

## Recommended next step, either way

The screen inventory above is the most valuable thing in the repo for us. **It should become tracker features** — roughly 30 entries across `uc`, `otc`, `cms`, `activity` — so the product surface is planned rather than discovered.

That is `tracker truth`, which sits on the graph's side of the split, so it belongs to them with this document as the input.

---

## Links

- Source: the vendored front-end tree
- Backend integration and the balance-ownership decision: [`2026-07-28-vendored-exchange-integration.md`](2026-07-28-vendored-exchange-integration.md)
- Realtime core already built: `packages/market-data`
