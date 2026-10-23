# Public invitation

Independent React public invitation app using the approved React/Vite customer toolchain. Its deployed static assets contain no Vue, iView, exchange shell or customer session. Original Cult/Magic React sources and their original field primitives are locally modified; source receipts and MIT notices are in `src/components`.

The existing public intake, encrypted draft storage, countries, exact review formatting and API client are imported as build-time framework-free source. They remain the single implementation of contact capture, continuation capabilities, UUID intent retries and revisions. This app introduces no identity or money book. The five audience schemas and public bare-JSON POST routes remain unchanged.

Serve only the independent `dist/` on HTTPS at exact `join.intafaced.com`; HTML paths `/`, `/join`, `/invest`, `/trade`, `/merchant`, `/academy`, `/partner` and `/join/*` return its index. `/api/ops/trpc/*` proxies to the existing edge without prefix rewrites. DNS/TLS/edge deployment are separate launch inputs. Do not serve the legacy exchange index on this host. This source does not provision hosting or send email.

`OUTREACH_CONTACT_URL` and `OUTREACH_RETENTION_NOTICE` are public publication seams, validated by the existing module. Set real approved notices only after actual retention/backup behavior is configured. No live mailbox receipt, production deployment or browser fixture constitutes those proofs.

Run from the monorepo root with Node24:

```sh
pnpm --filter @intafaced/invitation install --frozen-lockfile
pnpm --filter @intafaced/invitation dev
pnpm --filter @intafaced/invitation build
node apps/invitation/test/journey.browser.mjs
```

Vite prebundles the existing CommonJS controller/storage and mixed-module API client for development. Production bundles the same source through its CommonJS build transform. No Vue bootstrap, iView or exchange stylesheet is imported. `INVITATION_EDGE_URL` changes the local development proxy only. `vercel.json` describes the independent Vite output and cold-route fallback while excluding API paths; it does not supply a backend proxy or prove a deployment. The Vercel project must select `apps/invitation` and include required build-time source outside that app root.

The browser harness serves independent compiled assets with strict synthetic v1 API replies. It checks all five audiences, exact money strings, introduction-only amount skip, unsent review/edit, real tab reopening, same-intent lost-response recovery, added interests, expiry, keyboard, encrypted optional storage and unavailable storage. It never writes to a live service or sends email. Before running it, build the existing shared contracts artifacts. Recordings/screenshots are private `/tmp` artifacts; they establish the tested source version, not production readiness.

The focused browser regression runs after building with `node apps/invitation/test/focus.browser.mjs` from the repo root. It uses strict local fixture replies and a delayed display frame to check immediate sequential typing, unsent editing, tab reopening and the exact submitted message at 390px and 1280px.

Primary invitation actions use the original Cult MetalButton and original shadcn Button with the published original `metal-fx@2.0.11` runtime, copied locally with canvas-identity guards on its lost/restored handlers. One silver/dark preset is shared; decoration runs for a bounded 700 ms entrance/hover/focus window, then pauses, and stays paused while saving, disabled or reduced motion is requested. Native buttons retain submit/navigation handlers and reserve their normal caption footprint during pending feedback. The original runtime handles offscreen instances and WebGL fallback/context restoration. Distributed component notices include the bundled Paper Shaders Apache-2.0 notice and license.

The local runtime retains the original ESM and type surface. Its two event guards prevent an old renderer teardown event from marking a newly mounted renderer as lost. Native action visibility stays independent of the decorative first frame; no shader readiness gates form access. Package provenance and original MIT/Apache notices remain distributed.

The focused Metal regression (`node apps/invitation/test/metal.browser.mjs`) checks real sequential contact typing, old-context events against a newly mounted renderer, current-context loss/restoration and stable native pending submission. Hardware-browser evidence may use `METAL_BROWSER_EXECUTABLE` and `METAL_HEADED=1`; that mode creates a private temporary profile and verifies its owned process arguments before interaction. Software-rendered headless timing is recorded separately, without relaxing the native transition assertion.

The copied original MetalFx component also selects its existing native fallback when OffscreenCanvas allocation or shader initialization fails after the HTML-canvas support probe. The regression injects both failures and verifies visible keyboard-operable form submission without a page exception.
