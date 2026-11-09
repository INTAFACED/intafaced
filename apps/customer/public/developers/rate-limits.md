# Rate limits

How many calls an API key may make, what each call costs, what a refused call tells you, and how to ask for more.

## How the limit works

Each key has a bucket of tokens. The burst is the most the bucket holds, so it is how many calls of cost 1 the key can make at once. The bucket refills at a steady rate, the refill, up to the burst again.

Each call spends its route’s cost from the bucket. When the bucket holds less than the call’s cost, the call is refused with 429 and nothing is done.

Each server counts on its own, and a restart fills every bucket again.

The tiers and the cost per route are set by the owner and read live, never written into these pages: the tiers from /api/identity/trpc/apiRateTiers and the costs from /api/edge/rate-limits/costs. The page /developers/rate-limits shows both.

## A refused call

A call over the limit is answered 429 with code edge.rate_limited. The body names the reason (global: the key’s bucket is spent; endpoint: the route costs more than the whole burst; concurrency: too many calls at once), retryAfterSeconds and the requestId to quote to support.

The headers say the same: retry-after, x-ratelimit-reason, x-ratelimit-remaining (0), x-ratelimit-cost, x-ratelimit-limit and x-request-id. Every allowed call carries x-ratelimit-remaining and x-ratelimit-limit, so a program can slow down before it is refused.

## Backing off after a 429

Wait at least the retry-after seconds before the next try. If that try is refused too, back off exponentially: double the wait each time, up to a cap you choose, and add random jitter to each wait (any value between zero and the wait), so many clients refused together do not all retry at the same moment.

For example: wait retry-after, then a random time up to 2 seconds, then up to 4, then up to 8, and so on.

## Ask for a higher limit

Ask for a higher refill for one of your live keys, and tell us when a spike in traffic is coming. A reviewer answers every request.
