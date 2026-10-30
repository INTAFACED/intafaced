# REST conventions

How every trading REST route is shaped, so a client written once works on all of them.

- Resource addresses live under /api/v1 and name what they hold: /api/v1/orders, /api/v1/orders/:id, /api/v1/ticker/:symbol.
- Requests and answers are JSON, in UTF-8, sent as application/json.
- Times are UTC: timestamp is Unix milliseconds and datetime is the same instant in ISO 8601 with an offset. A since filter takes Unix milliseconds.
- Order ids are UUIDs, written as strings; an id that is not a UUID names no order and is refused as not found.
- A market is named by its symbol: BTC/USDT for spot, BTC/USDT:USDT for a linear perpetual, with an expiry suffix for a dated future. In a path the slash is encoded: /api/v1/ticker/BTC%2FUSDT.
- Every price, amount, fee and balance is a decimal string ("0.015"), never a JSON number.
- A refusal answers with its HTTP status and a JSON body that names it in code (a few trade price refusals name it in error instead). Most trade refusals also carry message and intafacedCode. Branch on the code, never on the wording of a message.

Lists page by since and limit today. Cursor paging (starting_after, ending_before and a next link) waits for DV-rest-01’s trade service change, and the default and largest page size wait for the owner.
