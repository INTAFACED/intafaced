# ADR: HSTS is ramped in stages from an env-driven setting, and never preloaded

- **Status:** accepted (phased). Phase 1 (this change): `HSTS_MAX_AGE_SECONDS` and `HSTS_INCLUDE_SUBDOMAINS`, read at runtime, validated at boot, in `apps/admin`. Phase 2: Caddy is the single owner of the header for every host it terminates (join and admin; chat 4 1 owns the Caddy config). Phase 3: customer nginx, later (`app.intafaced.com` is not in the first launch).
- **Date:** 2026-10-14
- **Deciders:** agents (Opus), reviewed by chat 2 2 and a fresh refuter. Step flips belong to the deploy owner (chat 4 1). Nitro decides anything that touches the live apex site or its DNS.
- **Area:** web edge and deployment: `apps/admin`, the TLS terminator (Caddy), later `apps/customer`.

## Context and problem

`Strict-Transport-Security` (HSTS) tells a browser to use only HTTPS for a host for `max-age` seconds. `includeSubDomains` extends that to every name under the host. `preload` asks browsers to ship the domain in their built-in list. This record fixes the value, the ramp and who flips each step.

What the code did before this change (checked on `main` at `f511beff2`):

- `apps/admin` sent `max-age=86400` from `next.config.mjs` `headers()`. Next 15.5.27 bakes that list into the routes manifest at `next build`, so one image could only ever carry one value.
- `apps/customer` nginx sends the same `max-age=86400` (`security-headers.conf.template`, `security-headers-api.conf`). Not changed here.
- `services/svc-edge/src/hardening.ts` deliberately sends no HSTS, and `hardening.test.ts` asserts that. HSTS belongs at the TLS terminator. Not changed here.
- Nothing in the repo terminates TLS. The route-to-live plan names Caddy on a VPS for join and admin.

Live facts, observed with DNS-over-HTTPS at 1.1.1.1 and `curl` on 2026-10-14 (UTC), one host at a time:

| Host                                         | Status                                                                            | HSTS today                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- |
| `intafaced.com` (apex)                       | Vercel marketing site, outside this repo; valid cert; http redirects 308 to https | `max-age=63072000`, host-only, set by Vercel |
| `www.intafaced.com`                          | Vercel; **certificate expired 2026-09-15** (`*.intafaced.com`, Let's Encrypt)     | none (TLS fails)                             |
| `trade.intafaced.com`                        | GitHub Pages                                                                      | none (Pages allows no custom headers)        |
| `autodiscover.` / `autoconfig.intafaced.com` | CNAMEs to Hostinger mail; certificate name mismatch                               | none                                         |
| `admin.` / `join.` / `app.` / `api.`         | not in DNS yet (NXDOMAIN)                                                         | not applicable                               |

The complete DNS zone is unverified: DNS cannot be listed through DoH, so this table holds only names someone could guess. The nameservers are Hostinger's (`dns-parking.com`) and there is no CAA record.

Two facts change the problem. The apex already sends a two-year host-only policy, so our one-day value guards only hosts that do not exist yet. And `includeSubDomains` and `preload` matter mostly on the apex, which is a Vercel project outside this repo.

## Decision drivers

- Downgrade and SSL-strip protection for a money product, especially on hostile Wi-Fi.
- Outage hazard. HSTS turns any certificate lapse into a hard failure that a user cannot click through, and one certificate (`www`) has already lapsed.
- Reversibility. A cached policy cannot be recalled before it expires; removal from the preload list takes months.
- The subdomain estate is unknown and shared with mail and third parties.
- Per-environment control without rebuilding images (images are promoted by digest).

## Considered options

- **(a) Keep one day.** Safe, but below the Mozilla minimum of six months and below every competitor sampled except PayPal's apex redirect.
- **(b) A staged ramp per host class, apex `includeSubDomains` only after a zone audit, no preload.** Follows hstspreload.org's own ramp advice. **Chosen.**
- **(c) One year, `includeSubDomains` and `preload` now.** What Stripe, Coinbase, Monzo and PayPal `www` send. For us it would break `www` for any visitor holding the apex pin (expired certificate), would touch a live site outside the repo, and is one-way. Rejected.
- **(d) Six months, host-only, fixed.** Meets Mozilla's minimum but has no ramp and stops short of the one-year value the standards converge on. Rejected.

## Decision

**Option (b), with `preload` removed from the plan permanently.**

### 1. Configuration (phase 1, in this change)

Two variables per deployment, read from the environment of the running process:

| Variable                  | Values                                     | Default                 |
| ------------------------- | ------------------------------------------ | ----------------------- |
| `HSTS_MAX_AGE_SECONDS`    | integer 0..63072000, canonical digits only | `86400` (today's value) |
| `HSTS_INCLUDE_SUBDOMAINS` | exactly `true` or `false`                  | `false`                 |

- The admin sets the header in `src/middleware.ts` from `process.env` on every response, formatting an already-validated value with no throw path. It is not in `next.config.mjs` and is never `NEXT_PUBLIC_*` or listed under next.config `env`, because either would inline the build-time value. Any page or API response records the policy; `/_next/` and files with an extension are skipped by the middleware matcher, which is acceptable for that reason.
- Validation lives in `src/instrumentation.ts` `register()`, because middleware cannot exit and a throw there is a 500 on every request. The process refuses to boot (exit 1, code `config.hsts_invalid`, naming variables and never values) on:
  - `hsts.max_age_invalid`: not an integer 0..63072000;
  - `hsts.include_subdomains_invalid`: not exactly `true` or `false`;
  - `hsts.max_age_above_non_production_cap`: more than 86400 outside production posture (`isProductionPosture` in `@intafaced/config`: `APP_ENV` anything but exactly `dev` or `test`), so a dev or test environment cannot pin more than a day (note: `APP_ENV=staging`, and an unset `APP_ENV` under `NODE_ENV=production` as `next start` sets, are production posture and CAN pin a year; no staging host exists yet);
  - `hsts.include_subdomains_on_registrable_domain` and `hsts.include_subdomains_host_unknown`: `HSTS_INCLUDE_SUBDOMAINS=true` while the host of `ADMIN_ORIGIN` is a registrable domain, or is not a readable URL. A "leaf" host that is not a leaf must not become a zone-wide policy.
- `isRegistrableDomain(host)` is deliberately conservative and is **not** the Public Suffix List. It treats a host with two labels or fewer, an IP literal, or a three-label host whose last two labels are in a short built-in list (`co.uk`, `com.au`, `co.jp` and similar) as registrable. Limitation: private suffixes (`github.io`, `vercel.app`) and rarer public suffixes are not recognised, so `x.vercel.app` passes as a leaf. It catches the common mistake; it is not proof of leafness.
- There is no `preload` token in any value this code can emit and no `HSTS_PRELOAD` variable. Tests ban the token in every admin-emitted value. The ban protects little on its own (browsers honour preload only through the list), but it is cheap and it keeps a future edit honest.
- HSTS is sent regardless of scheme and port, exactly as before: TLS ends in front of the process, and browsers ignore the header over plain http. Local `http://localhost` development is therefore unchanged.

### 2. The ramp

Stage values apply per host. `includeSubDomains` is added on leaf hosts (`admin.`, `join.`) from S1, since nothing lives under them. "Clean" means: zero certificate or monitor alerts, no TLS-error reports, and the header matches the expected stage on every host.

| Stage | Value                                 | When it may start                     | Gate                                                                                                   |
| ----- | ------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| S0    | `max-age=86400`                       | now                                   | none                                                                                                   |
| S1    | `max-age=604800; includeSubDomains`   | after the `hsts-check` monitor exists | monitor scheduled and alerting somewhere a human reads                                                 |
| S2    | `max-age=2592000; includeSubDomains`  | after one clean week at S1            | clean                                                                                                  |
| S3    | `max-age=15768000; includeSubDomains` | after one clean month at S2           | clean                                                                                                  |
| S4    | `max-age=31536000; includeSubDomains` | about go-live + 60 to 65 days         | at least one **observed automated certificate renewal per host** (the monitor sees `notAfter` advance) |
| S5    | `max-age=63072000; includeSubDomains` | S4 + 6 months                         | clean                                                                                                  |

S3 lasts until the S4 gate is met, not its full max-age (the hstspreload.org wait-the-full-max-age rule exists for includeSubDomains discovery; nothing lives under these leaf hosts; the full-wait rule applies to the apex ramp). S3 is an interpolation I added so the jump from one month to one year is not a single step; it is the Mozilla six-month minimum. Skipping it is allowed if S2 has been clean for the full month and the S4 gate is met. The one-year step waits for a renewal because Let's Encrypt certificates last 90 days and the first renewal is the first moment an HSTS-pinned user could be locked out by a broken renewal job; the `www` expiry shows this failure is not hypothetical here.

### 3. Apex `intafaced.com` (Vercel, outside this repo)

Keep Vercel's two-year host-only header untouched. Add `includeSubDomains` at the apex only after all of these hold:

- the `www` certificate is fixed (separate task; the apex pin currently makes `www` unreachable only for visitors who already hold it);
- a full Hostinger zone export is reconciled against the inventory above;
- every A and CNAME record either serves a valid certificate or is deleted. The Hostinger `autodiscover` and `autoconfig` names are accepted as browser-unreachable, since mail clients use their own discovery (Thunderbird behaviour unverified);
- the email provider's link-tracking domain is on HTTPS, or tracking is off;
- LiveKit and media hosts are on `wss`/`https`.

Trade-off, stated: ramping the apex from host-only `63072000` down to `604800; includeSubDomains` weakens returning visitors' apex pin for the length of the ramp. Start the apex ramp at `2592000` once the zone audit is clean. The apex is not changed by this repo.

### 4. Who owns the header

- **Caddy** is the single HSTS owner for every host it terminates (join and admin at launch). It must emit the header from the same validated environment values. If an app also sends its own header, Caddy must replace or defer it: RFC 6797 section 8.1 says a user agent processes only the first header, so two different values are a silent bug. The exact `header` and `defer` semantics are unverified and must be tested when the config lands. Until then the admin's own header is what an `admin.` visitor sees, and **join sends NO HSTS at all**: join does not go live without Caddy emitting the stage value (launch-checklist item for chat 4 1).
- `svc-edge` keeps sending none.
- Customer nginx moves to the same two variables later (phase 3, lower priority).

## Evidence

Everything below was fetched on 2026-10-14. Items I could not confirm are listed last, not asserted.

Competitor headers, `curl` GET or HEAD, with `preload status` from `https://hstspreload.org/api/v2/status?domain=<apex>`:

| Name          | Header observed                                | Preload status                                                  |
| ------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Stripe        | `max-age=63072000; includeSubDomains; preload` | preloaded                                                       |
| Coinbase      | `max-age=31536000; includeSubDomains; preload` | preloaded                                                       |
| Monzo         | `max-age=31536000; includeSubDomains; preload` | preloaded                                                       |
| Kraken        | `max-age=31536000; includeSubDomains; preload` | **removed** from the list; now fails `redirects.http.www_first` |
| Wise          | `max-age=31536000` (host-only)                 | not on list                                                     |
| Revolut (www) | `max-age=2592000; includeSubDomains; preload`  | not on list (ineligible: max-age below one year)                |
| PayPal (www)  | `max-age=31536000; includeSubDomains; preload` | preloaded; the apex redirect sends `max-age=300`                |

Standards and guidance:

- **hstspreload.org**, Deployment Recommendations: ramp `max-age=300; includeSubDomains`, then one week, then one month, and "wait the full max-age of the stage before you move on". It says to examine all subdomains, "including internal subdomains".
- **hstspreload.org**, Preloading HSTS: "The benefits provided by HSTS preloading are minimal compared to the benefits provided by HSTS. While HSTS is recommended, HSTS preloading is not recommended." Removal "takes months" and the site cannot make "guarantees about other browsers".
- **RFC 6797** section 8.1: `max-age=0` makes the user agent remove the policy; only the first Strict-Transport-Security header is processed. Section 11.2 suggests a default `max-age` of zero for configuration systems (we default to the shipped one day instead, because zero would silently strip a protection already shipped, and hard validation catches typos).
- **Mozilla Web Security Guidelines**, HSTS: "max-age must be set to a minimum of six months (15768000), but longer periods such as two years (63072000) are recommended"; "Extreme care is needed when setting the includeSubDomains flag."
- **OWASP HSTS Cheat Sheet**: recommends a very short `max-age` such as 86400 for the first rollout, and warns that preload "can have PERMANENT CONSEQUENCES".

Unverified: OMB M-15-13 "at least one year" (search snippet only); NIST SP 800-52r2 and PCI DSS 4.0.1 wording; Vercel's documented default HSTS (only the header was observed); that wildcard-certificate renewal needing Vercel nameservers is why `www` lapsed (an inference); Chrome's "Always Use Secure Connections" default (from memory).

## Consequences

- **Good.** One built image can run at a different stage per deployment, with no rebuild. A bad value stops the container instead of shipping a wrong header. No browser-list entry we cannot take back. Money hosts reach the one-year mark about two months after go-live, with no unrecoverable step before it.
- **Bad.** A first-ever visit to a host over a hostile network can still be stripped; browser HTTPS upgrades mostly cover this. Our hosts sit several stages behind Stripe and Coinbase until S4. Static files under `/_next/` no longer carry the header (the policy is still recorded by any page or API response).
- **Risk.** A certificate lapse on any HSTS host becomes a hard outage. Two different STS headers (Caddy plus an app) collide; only the first counts.
- **Monitoring required before the later stages.** A scheduled `hsts-check` (planned as `tooling/scripts/hsts-check.mjs`, not in this change) for every inventoried host: expected value per stage, certificate expiry more than 14 days away, same-host http-to-https redirect. It must refuse `HSTS_INCLUDE_SUBDOMAINS=true` on a registrable domain, as the admin validator does. Certificate-expiry monitoring for every host is a recorded precondition for the later stages, not a blocker for this ADR.

## Reversibility

- **Two-way for max-age ramps.** Lowering `max-age` reaches only browsers that come back; users already pinned at S4 stay pinned for up to a year. `HSTS_MAX_AGE_SECONDS=0` clears the policy for returning visitors (RFC 6797 section 8.1); use it only when we have deliberately left HTTPS for good. The real rollback is keeping HTTPS working, which is why certificate monitoring gates S4.
- **One-way: preload.** Removal from the list takes months and other browsers give no guarantee. That is why it is refused, not merely deferred.
- **Apex `includeSubDomains`** is a one-to-two-year commitment for every name under the domain.

## Revisit when

- Before each stage: the gate in the table.
- Preload: only if, at S5 + 90 days, the apex has run at one year with `includeSubDomains` for 90 days without incident, the apex is under our control or its owner agrees, and a bank partner, regulator or penetration test requires it or hstspreload.org changes its stance. It needs a new ADR.
- Immediately on any new subdomain, a new email or CDN provider, a change of TLS terminator, or any certificate-expiry alert.

## Open items (tracked by chat 4 1, not by this PR)

Chat 4 1 owns these and has already drafted them (`~/.codex/context/intafaced/route-to-live/WWW-CERTIFICATE-FIX.md` and `CHECKLIST.md`, lines 83-88, 2026-10-14):

1. `https://www.intafaced.com` serves an expired certificate (since 2026-09-15): the www fix (www redirects to the apex, the wildcard domain is removed) needs whoever holds the Vercel project and the DNS account.
2. A read-only export of the Hostinger DNS zone for `intafaced.com` (the gate for apex `includeSubDomains`): already requested there.
3. Final hostnames: admin and join behind Caddy; `app.` reserved and not in this launch; no `api.`/`edge.` host.
