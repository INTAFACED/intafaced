# ADR: The ramp widget is retired, and no other website may frame our ramp

**Status:** Accepted for "retire the iframe widget and keep a hosted-page-only posture". The partner session link and the `ramp_partners` registry are **designed, not built** (nothing in the repo implements them); that part stays Proposed until a trigger below fires.  
**Date:** 2026-10-14  
**Decision owner:** Nitro. **Written by:** agents (Claude), reviewed by an adversarial pass.  
**Area:** bank ramps and edge security headers (`svc-edge`, `apps/customer`; later `svc-bank`, `svc-identity`, `apps/admin`).  
**Policy rule:** `RAMP-NO-FRAMING` (see the register entry at the end).

## Context and problem

Should other websites be able to put our fiat/crypto on/off-ramp inside their own pages (an "iframe widget"), and under what rules?

What the code does at the time of writing (`origin/main` @ `f511beff2`, 2026-10-14):

- `GET /api/widget/ramp` (`services/svc-edge/src/widget-ramp.ts`) stripped `X-Frame-Options` and sent `Content-Security-Policy: frame-ancestors *`, so any website could frame it. The only gate was one global env string, `INFRA_LICENCE`, not a per-partner check. The `allowFraming` call ran **before** the licence check, so even the "licence unset" refuse page could be framed.
- With a licence set, the page rendered two inner iframes, `/bank/ramps` and `/api/pay/checkout`. Both refuse framing: the customer nginx sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` (`apps/customer/security-headers.conf.template`), and pay checkout sends the same (`services/svc-pay/src/checkout-page.ts`). `/api/pay/checkout` with no token has no session to show anyway. **So the widget never worked**: a licensed partner got a branded shell holding two "refused to connect" boxes. The tracker row marking it DONE 2026-08-23 was wrong and is corrected in the same change.
- `INFRA_LICENCE` is not set in any workflow in the repo, so the live path was the 403 refuse page, still framable.
- `/bank/ramps` is itself hidden in the customer feature registry ("ramps not set up"). Off-ramp and changing the withdraw destination need a 5-minute `trade:withdraw` step-up, a passkey second factor.
- The customer session lives in memory only (`apps/customer/src/features/session/session.tsx`, Bearer header in `apps/customer/src/shared/api.ts`).
- The only origin lists we have are on user-owned API keys (`api_keys.domain_whitelist`: host-only, suffix match, empty means unrestricted, self-serve). That is the wrong trust source for deciding who may frame a money page.
- There is no partner registry table and no CSP violation reporting. There is no Fetch-Metadata (`Sec-Fetch-*`) handling in `svc-edge` or `apps/customer` (`apps/admin` does use it).
- The vendored `/platform` page handed partners the iframe snippet (`vendor/upstream-exchange/05_Web_Front`, retired from deploy 2026-10-13).

**How bad was `frame-ancestors *`, honestly?** LOW and latent, not a live money-page exposure. Nothing real was clickjackable: the framed page had no state-changing UI, both inner frames refuse, and its links only navigate to our own origin. The risk was that someone later "fixes" the inner frames (or adds UI to the shell) and a money page becomes framable by every site on the web.

Who is affected: future distribution partners (wallets, dapps, merchants). Nothing live is blocked, because ramps are hidden.

## Decision drivers

- Clickjacking and UI-redress on a money page; money-out is the worst case.
- Passkey sign-in and step-up must work. WebAuthn inside cross-origin frames is partial, and Safari is the weak point.
- Partners want users to stay "in their product", but several leading ramps push a redirect or new-tab path for KYC, Safari and wallets.
- Open-redirect and phishing risk from return URLs and branding.
- Who is liable for third-party distribution is unresolved counsel work (tracker §37/§38).
- Reversibility, and the cost of dynamic per-partner headers on a static nginx SPA.

## Considered options

**(a) No framing. A hosted top-level page reached by a server-created, single-use session link and an allow-listed return URL.** The partner backend creates a session with its API key. The user opens our URL by redirect or new tab, signs in first-party, transacts, and returns to the partner's return URL.

- Pros: passkeys and step-up work top-level in every browser; clickjacking stays impossible; reuses today's headers unchanged; small build.
- Cons: the user leaves the partner's page; there is no in-page event stream, only a return redirect plus a server-side status read.

**(b) Framing only for allow-listed partner origins.** A partner record yields an exact `frame-ancestors https://partner.example` header, plus `postMessage` events sent to that exact origin.

- Pros: in-page experience, which MoonPay, Stripe and others sell.
- Cons: per-request dynamic headers on a static SPA; Safari WebAuthn and storage problems inside frames; partners must set `allow=` attributes; nested frames; a larger test surface.

**(c) Any origin may frame.** This is what the code did. Rejected: MoonPay's own FAQ says its allowlist exists "to prevent unauthorized third-parties from embedding", and arbitrary framing of a money page is a clickjacking exposure (OWASP Clickjacking Defense Cheat Sheet).

## Evidence

Only claims that were read at the source on 2026-10-14 are listed as established. Confidence is stated per row.

| Provider             | What the source says                                                                                                                                                                                                                                           | Source                                                                                                                     | Confidence                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| MoonPay              | Domain allowlist for embedding "to prevent unauthorized third-parties from embedding"                                                                                                                                                                          | https://dev.moonpay.com/widget/faqs                                                                                        | High (FAQ read)                                                     |
| Transak              | Widget URL is created by a backend call, valid 5 minutes, session single use; nesting in a third-party iframe needs Transak approval. Its examples open a new tab; it does not state that a new tab is recommended                                             | https://docs.transak.com/guides/migration-to-api-based-transak-widget-url.md ; https://docs.transak.com/docs/redirect-link | High for the URL and nesting rules                                  |
| Banxa                | Falls back to a redirect where third-party cookies are blocked (Safari) and for KYC and Apple Pay. A legacy `iframe_domain` allowlist exists in its docs, but how it is enforced was not verified                                                              | https://docs.banxa.com/products/hosted-checkout/docs/checkout-experience/iframe/iframe-web.md                              | High for the redirects; allowlist unverified                        |
| Coinbase Onramp      | Session token required from 2025-07-31, server generated, 5 minutes, single use                                                                                                                                                                                | https://docs.cdp.coinbase.com/onramp-&-offramp/session-token-authentication                                                | Medium (search-derived; the direct fetch failed)                    |
| Stripe Crypto Onramp | A server mints a session and the browser gets only a `client_secret`. The dashboard takes a list of registered domains where the onramp is hosted, so the model is an embed on the partner's domain. `crypto.stripe.com` itself sends `frame-ancestors 'none'` | https://docs.stripe.com/crypto/onramp/embedded ; `curl -sI`                                                                | High. This is evidence for option (b), **not** for hosted-page-only |
| Passkeys in frames   | web.dev: `publickey-credentials-get` in a cross-origin iframe is not supported in Safari. Other sources disagree, so Safari is unreliable                                                                                                                      | https://web.dev/articles/webauthn-within-iframe                                                                            | Medium-High                                                         |
| Clickjacking and CSP | Use `frame-ancestors` with explicit origins; `X-Frame-Options` cannot list several origins; `frame-ancestors` is ignored in `<meta>`                                                                                                                           | https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html ; https://www.w3.org/TR/CSP3/         | High                                                                |

Not relied on (could not be verified, so no part of the decision rests on them): Mercuryo's signature and iframe rules, Ramp Network's domain allowlist, 3-D Secure 2 challenge window sizes, and the EBA opinion on redirects (it concerns bank interfaces for third-party providers, not our own first-party redirect).

Honest reading of the evidence: the industry splits. MoonPay, Stripe and Banxa sell an embed with a registered-domain allowlist, which is option (b). Coinbase and Transak push a server-created single-use link, which is option (a). Nobody serious runs option (c) for the money flow.

## Decision outcome

**Retire the iframe widget and keep a hosted-page-only posture (accepted). The partner session link is the designed next step, not built. Option (b) is deferred behind a trigger. Option (c) is removed.**

Why (a) for INTAFACED, and not "because Stripe does it":

- Our passkeys work **top-level**. That is the real differentiator, not the in-memory session: a memory-only session also forces a sign-in on a new tab. Passkey step-up for money-out is unreliable in cross-origin frames, especially Safari.
- Mobile-wallet partners usually open top-level pages inside an in-app WKWebView or Android WebView, where passkeys are also unreliable. So the deferred design below must **require** the system browser, `SFSafariViewController`, `ASWebAuthenticationSession` or Android Custom Tabs, never a plain in-app webview.
- Ramps are not live and nothing depends on the widget. An embed is a large build for a feature with no partner.

### What changes now (this PR)

1. `GET /api/widget/ramp` answers **HTTP 410** with JSON `{ code: 'ops.widget_iframe_retired', message }` and the headers `x-frame-options: DENY`, `content-security-policy: frame-ancestors 'none'`, `cache-control: no-store` (the framing headers `svc-pay` checkout also sends). No page is rendered. `frame-ancestors *` and the `X-Frame-Options` stripping are gone.
2. Each hit logs (pino, info) `sec-fetch-dest` and the **Referer origin only** (no path, no query), so the revisit trigger can be measured.
3. `INFRA_LICENCE`, `INFRA_WIDGET_ACCENT` and `INFRA_WIDGET_CSS` are removed from `svc-edge/src/env.ts` and the compose file, because nothing reads them any more.
4. The customer nginx `X-Frame-Options: DENY` and `frame-ancestors 'none'` stay untouched; a test pins them.
5. The stale consumers are removed or corrected: the `/platform` preview iframe, copy-snippet card and widget probe, the golden test that pinned the old widget, two false comments about nginx, and the tracker row `ops.infra-b2b` (was DONE, now an honest `socket` with a note).

### Designed, NOT built: partner session link and `ramp_partners` registry

Recorded now so nobody improvises it. Nothing below exists in the repo.

- A partner backend calls `POST /api/widget/ramp/sessions` with a partner API key and gets back `{ url, expires_at }`. The session token is 128-bit random, stored hashed, 5-minute TTL, single use. It grants **no authority**: it is not a login and moves no money; it carries only prefill, attribution and the return target.
- A new `ramp_partners` table in `svc-identity` is the registry: `id`, `org_id`, `display_name`, `status` (sandbox, live, suspended), `return_origins[]` (exact `https://host[:port]`, no wildcards, max 5), and the id of the partner API key. Only operators write it (in `apps/admin`); it is never self-serve. `api_keys.domain_whitelist` is deliberately not reused.
- The hosted page is a top-level route in the customer SPA, opened by redirect or new tab, behind the same hidden flag as `/bank/ramps`.

Requirements that this design MUST meet when built:

1. **The session token never goes in the query string.** nginx logs the full request line and `svc-edge` pino logs `req.url`. Use the URL fragment: `/ramp/start#s=<token>`. The page redeems it with a **POST body**, then removes it from the address bar with `history.replaceState`.
2. **Redeem only after first-party authentication**, and bind `user_id` at redemption. The unredeemed token is held in `sessionStorage` across the sign-in.
3. **Expiry is checked inside the same statement**: `UPDATE ... SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING ...`. No separate read-then-check.
4. **Prefilled `destination_address` is for ON-ramp only.** It is never an off-ramp payout destination. Any externally supplied address must pass the existing withdrawal-address controls (new-address hold, step-up) and show the warning "an address chosen by <Partner>; continue only if it is yours".
5. **`ramp:session:create` is never in any user-grantable scope set.** It must sit above the `assertDelegateCannotGrant` ceiling (`services/svc-identity/src/router.ts`, around lines 1319-1345). Only operators issue partner keys, and the key id is stored on the `ramp_partners` row.
6. **`GET /api/widget/ramp/sessions/:id`** checks `session.partner_id === caller.partner_id`, uses non-sequential ids, and returns no PII.
7. **`return_url` is validated server-side only**, by WHATWG `URL` `.origin` equality against the registered `return_origins`, and re-checked at redirect time. Appended parameters (`ramp_session`, `status`) are built with `URLSearchParams`, never string concatenation, and never carry amounts or PII.
8. **System browser required** for partner mobile apps (see above). No `window.opener` messaging: our COOP `same-origin` severs popups on purpose.
9. The page shows "Started from <partner display name>" so a fake partner context is visible to the user.

### Deferred phase 2: framing for allow-listed partners (option b)

Only for on-ramp (value-in). Money-out and step-up always leave the frame for a top-level window. The embed document is served by `svc-edge` (not static nginx), sends `Content-Security-Policy: frame-ancestors <exact registered frame origins>` and **omits** `X-Frame-Options` (it cannot express a list, and `DENY` would break the embed). It sends `Permissions-Policy: publickey-credentials-get=(self)`, and partners add `allow="publickey-credentials-get; payment; camera"`. `postMessage` goes only to the session's exact origin (never `'*'`) with no inbound commands. If the frame is in Safari or the user is signed out, it shows "Continue in a new tab".

## Consequences

- Good: clickjacking on the ramp stays impossible; the false DONE tracker row is corrected; dead licence and white-label env is gone; every blocked-embed attempt now leaves a count we can use.
- Bad: if a partner wants an in-page embed today, we cannot offer it, and partners that insist will pick MoonPay or Transak for now. There is also no partner distribution path at all until the session link is built.
- Risks: the 410 route is public and unauthenticated, so the log line must stay cheap and must never record a path or query (a test pins this). A browser that is told `frame-ancestors 'none'` shows its own blocked-frame error; CSP cannot render a custom page.

## Reversibility

Two-way door. Retiring the route costs nothing because no partner exists. The session link is additive: a table, two endpoints, one SPA route. Phase 2 adds a `frame_origins` column to the same registry without breaking session links. Re-opening framing later is one header change plus the registry.

## Revisit when

- A signed partner contract requires an in-page embed, **and** the logged iframe attempts (`sec-fetch-dest: iframe` with the Referer origin, now present) or the partner pipeline show real demand. Then build the session link first, and phase 2 for on-ramp only.
- Safari ships passkey support in cross-origin frames (re-check web.dev and MDN each quarter).
- Counsel resolves who carries liability for third-party distribution (tracker §37/§38).

## Policy register entry

| Rule id           | Rule                                                                                  | ADR                                                         | Status   | Owner |
| ----------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------- | ----- |
| `RAMP-NO-FRAMING` | No third-party site may frame any ramp, checkout or bank page; hosted top-level only. | `docs/adr/2026-10-14-ramp-widget-no-third-party-framing.md` | Accepted | Nitro |
