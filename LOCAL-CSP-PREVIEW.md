# Local CSP preview

The customer app served behind the exact security headers (CSP, HSTS, Permissions-Policy, COOP, frame rules) that merged in #4662. Test data only: no real account, balance or service.

## Open this
Start page (checklist and live violation list): http://localhost:18080/__csp-preview/

| Link | What it is |
|---|---|
| http://localhost:18080/login | Production build, LiveKit and storage origins configured |
| http://localhost:18081/login | Production build, the three CUSTOMER_* variables EMPTY (the shipped default) |
| http://localhost:18085/login | Academy copy (local-test-stack build, hidden rooms on), origins configured |
| http://localhost:18086/login | Academy copy, origins EMPTY |

Use `localhost`, not `127.0.0.1` (passkeys are tied to the host name). Sign-in is held in memory only: do not reload after signing in. Use deep links like `/login/returnUrl/%2Facademy`, which sign you in and land on the room.

## Start / stop
```
cd /Users/Nitro/projects/sovereign-worktrees/feat-local-csp-preview
node tooling/local-csp-preview/csp-preview.mjs start     # stub + 4 nginx containers, prints links
node tooling/local-csp-preview/csp-preview.mjs status
node tooling/local-csp-preview/csp-preview.mjs stop      # stops only what start recorded
```
PIDs and container names are recorded in `tooling/local-csp-preview/.state/pids.json`. Ports 18080-18086 only (18090 is used by something else and is not touched). Needs Docker running and image `nginx:1.30.5-alpine` (the tag the customer Dockerfile uses).

Rebuild after code changes:
`pnpm --filter @intafaced/customer build` (production dist), and for the Academy copies
`cd apps/customer && INTAFACED_LOCAL_STACK_BUILD=1 VITE_LOCAL_TEST=1 pnpm exec vite build --outDir ../../tooling/local-csp-preview/.state/dist-ribbon --emptyOutDir`.

## What is real and what is not
- Real: the nginx image, `apps/customer/nginx.conf`, `security-headers.conf.template`, `csp-origins.envsh`, `security-headers-api.conf`. The image's own entrypoint renders the headers. A test compares what nginx rendered to the repo's own renderer (`apps/customer/deployment/render-security-headers.mjs`) byte for byte.
- Changed only for local use: upstream hosts point at the local stub; a duplicate `Content-Security-Policy-Report-Only` header (same policy plus `report-uri /__csp-report`) feeds the violation collector; extra locations `/__csp-report` and `/__csp-preview/`. The enforced headers are untouched.
- Origin values (test): LiveKit `ws://127.0.0.1:18084` (a dead-end stand-in, not LiveKit), storage `https://storage.csp-preview.invalid`. Real hosts are a deploy-time choice and not needed for this check.
- Backend: a TEST-data stub (`stub.mjs`). Any email and password sign in. Passkey options are real browser ceremonies, but the stub does not verify signatures. Prices come from the repo's Home test fixtures.

## What to click and what good looks like
1. Sign in at :18080/login with any email and password. Good: Home appears with TEST prices.
2. Security (`/login/returnUrl/%2Fuc%2Fsafe`): Add passkey, confirm with Touch ID. Good: a passkey row appears.
3. Login page: email plus passkey button. Good: Touch ID, then Home.
4. Chart: `/login/returnUrl/%2Ftrade%2Fspot%2FBTC-USDT` and `%2Fcoin%2FBTC`. Good: candles draw.
5. Academy on :18085: Rooms, Open room, press Connect audio/video on session A then B. A: connection error, NO violation. B: one connect-src violation for `blocked-livekit.csp-preview.invalid` (expected).
6. Academy Videos: allowed host, no violation; not-allowed host, one media-src violation (expected).
7. Same on :18086: both sessions and both videos now violate (nothing is allowed). That is why the three variables matter.

Violations show live at the bottom of the start page, and are written to `tooling/local-csp-preview/.state/violations.jsonl` (query strings stripped). The browser console (Cmd+Option+J) shows the same as "Refused to ...".

## Automated checks (run by the agent)
- `node --test tooling/local-csp-preview/verify.node-test.mjs`: 42 pass (headers byte-identical on 8 paths per copy, API proxy headers, bad-origin refusal).
- `node tooling/local-csp-preview/browser-check.mjs [--shots dir]`: headless Chromium with a virtual passkey authenticator; sign-in, passkey register and sign-in, chart, 9-room sweep, Academy sessions and videos.

## Findings
- font-src: every page load logs one violation, `data:font/woff2` blocked by `font-src 'self'`. Vite inlines a small JetBrains Mono (extended Cyrillic) subset into the CSS. Fix options: add `data:` to `font-src` in the template, or set `build.assetsInlineLimit` so fonts are never inlined.
- Academy (and the other "more rooms") are a hidden feature in the production build, so customers cannot reach Academy live or video there today; the two Academy copies use the local-test-stack build to test it.
- Not testable here: a real LiveKit session (no server), real recorded video (needs a real https storage host), real passkey verification, real data on any screen.
