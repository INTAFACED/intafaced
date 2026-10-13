# Outreach local preview

`pnpm preview:outreach` starts the investor questionnaire and the founder CRM on this Mac, with test data:

- Questionnaire: http://localhost:4400/invest
- Founder CRM: http://localhost:4401/crm. Sign in with any email and password, and code `123456`.

Both apps read and write one in-memory test store (`fixture.mjs`), so an enquiry sent from the questionnaire appears in the CRM. Restarting resets the store. Nothing is saved, emailed or deployed, and every page carries a "Local preview · test data · not live" label. Every reply is parsed with the shared contract schemas from `@intafaced/contracts`.

`pnpm preview:outreach --lan` also serves the questionnaire to phones on the same Wi-Fi and prints that address. The founder console stays on this Mac: it refuses plain-HTTP origins other than localhost, and its sign-in cookie needs HTTPS.

The first run builds the shared packages, the questionnaire and the founder console. Later runs rebuild only when a commit changes the apps, shared packages or lockfile; pass `--rebuild` after editing source locally. The questionnaire build embeds the approved privacy contact and retention notice, the same values the real `join` build must set.

`node tooling/preview/outreach/click-through.browser.mjs [dir]` checks a running preview end to end at 390px and 1280px. It sends one investor enquiry, signs in to the CRM and opens that enquiry, then saves screenshots.

Only the CRM tab is backed by the test store. Other console pages (kill switches, ledger, tools) show their normal "unavailable" states.
