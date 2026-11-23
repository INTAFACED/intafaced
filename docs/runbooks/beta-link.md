# The beta link

The Customer app on the latest `main`, always on, on TEST funds only, for the owner's beta walk on his phone (#9346).

- **Link:** `http://localhost:6210/`
- **TEST mailbox** (the sign-up codes the app sends): `http://localhost:6290/`
- **State now:** `node tooling/beta/beta-host.mjs status` on the box (`~/.intafaced/beta/status.json`): `up` with the
  main commit it shows, `blocked` or `down` with the reason.

## How it works

One copy of the local test stack (`tooling/scripts/local-test-stack.mjs`) runs on the Linux box, in its own checkout of
`origin/main` (`~/.intafaced/beta/checkout`), its own state folder (`~/.intafaced/beta/state`) and slot 3, so its ports
never move. The systemd user service `intafaced-beta.service` runs `tooling/beta/beta-host.mjs serve`, which every 30
minutes fetches main and runs `verify launch`, which readies the stack the way a journeys shard is readied and restarts
what is down. At most once every 2 hours it first moves the checkout to main and installs, so the launch rebuilds what
changed: a merge to main is on the link within about two and a half hours. The mailbox page names the commit served.

**Who can open it (the allow list):** the stack listens only on the box's own loopback. Nothing on the internet or the
home network can reach it. It opens only through T3 Connect's preview tunnel, on a device signed in to the owner's T3
Connect account and approved for the box ("Require approval for new devices" is on). No new account, sign-in or spend.

**TEST funds only, shown by a check:** after every round, `beta-host.mjs check` reads the environment of every process
the stack started and fails when any address names a host other than this machine, so no service has a route to a real
chain, venue, bank or card rail. It also checks that the page carries the TEST banner. A failed check stops the stack.
Blank prices and limits refuse, as on every test stack. Every rail is a TEST stand-in (`docs/LOCAL-TEST-STACK.md`).

## Sign in as a test customer, on the phone

1. On your phone, open the T3 app and any chat on the Linux box.
2. Open a browser tab in T3 and go to `http://localhost:6210/`. In the tab's menu, tap **Open on this device**. The app
   opens in the phone's own browser view. (A long press on the link in a chat does the same.)
3. Tap **Sign up**. Enter any email ending in `@local-test.invalid` (for example `nino1@local-test.invalid`), a handle,
   a password of your choice, a country, "No, I am not a US person", and a birth date. Tap **Create account**.
4. The app asks for the code from the email. Open a second tab at `http://localhost:6290/` (**Open on this device**
   again): the TEST mailbox shows the newest code for your address. Type it in and tap **Confirm and open my account**.
5. You are on Home, in Volt, dark. To unlock the rooms that need a verified person, open **Verification**, request
   **Full**, enter any country code, and submit: the stack's TEST operators approve it within a minute. Sign out and in
   once so the app sees it. On a hosted beta the founders approve it instead (`docs/runbooks/beta-founders.md`).

Everything you see is TEST: prices, balances and limits carry the TEST label, and nothing can move real money.

## When it is not up

- **`blocked`: no TEST screening file.** Edge refuses every call until a sanctions screening list is set, and no agent
  invents one. The owner's approved TEST fixture lives in the repository secrets `INTAFACED_SANCTIONS_REGIONS` and
  `INTAFACED_SANCTIONS_LIST_SOURCE`; by his decision (`tooling/ci/ci-review/REVIEW.md`, entry of 2026-11-22) an agent
  dispatches `beta-screening-seal.yml`, which seals them to the box's key `tooling/beta/seal.pub.pem`, downloads the
  artifact and decrypts it, unseen, into `~/.intafaced/beta/state/screening.local.json` (mode 600,
  `{"regions": "...", "source": "..."}`, the same file `docs/LOCAL-TEST-STACK.md` names). The next round starts the
  stack.
- **`down`:** the reason names the step; the round's log is `~/.intafaced/beta/round.log`. The next round tries again.
- **`refused`:** the TEST funds check found a route off the machine; the stack stays stopped until a change on main
  removes it.

Install once on the box, from the beta checkout: `node ~/.intafaced/beta/checkout/tooling/beta/beta-host.mjs install`.
Stop: `systemctl --user stop intafaced-beta.service`, then `node tooling/beta/beta-host.mjs stop`.
