# The beta link

The Customer app on the latest `main`, always on, on TEST funds only, for the owner's beta walk and the people he invites (#9346).

- **Link:** `https://beta.intafaced.com/`, behind a login only invited emails pass
- **TEST mailbox** (the codes the app sends): `https://beta-mail.intafaced.com/`, behind the same login
- **On the box itself:** `http://localhost:6210/` and `http://localhost:6290/`
- **State now:** `node tooling/beta/beta-host.mjs status` on the box (`~/.intafaced/beta/status.json`): its first line
  names the state, the commit served, main's commit when it differs, and why (`up`, `updating` while a round moves it,
  `blocked` or `down` with the reason).
- **Where each tester is:** `node tooling/beta/beta-host.mjs testers` on the box (`--json` for the same as data): one
  block per invited account, by account id: signed up, wallet made, funded, desk reached, first order, the venue's
  refusals with their words, errors, the last thing they did, and STUCK with why (an error after their last stage, or no
  new stage for 30 minutes short of a first order).
- **Move it now:** `node tooling/beta/beta-host.mjs move` on the box, for a fix testers need before the daily slot.
- **Move it back:** `node tooling/beta/beta-host.mjs back [<sha>]` on the box, for a commit that came up but broke
  testers: within 15 seconds it goes back to `<sha>`, a commit on main (default: the one before the commit served), and
  holds there until main moves past the main of that moment; `status` names the held commit and why, and `move` ends the
  hold at once (#11065).

## How it works

One copy of the local test stack (`tooling/scripts/local-test-stack.mjs`) runs on the Linux box, in its own checkout of
`origin/main` (`~/.intafaced/beta/checkout`), its own state folder (`~/.intafaced/beta/state`) and slot 3, so its ports
never move. The systemd user service `intafaced-beta.service` runs `tooling/beta/beta-host.mjs serve`, which every 30
minutes fetches main and runs `verify launch`, which readies the stack the way a journeys shard is readied and restarts
what is down. When main has moved, it first moves the checkout to main and installs, so the launch rebuilds what
changed: a merge to main is on the link within about 35 minutes. The mailbox page names the commit served.

**Only the launch desk runs.** The beta starts the stack with `LOCAL_STACK_PROFILE=launch-desk`
(`tooling/scripts/local-stack-profile.mjs`): identity, edge, customer, notify, bank, ops, pay, ledger and its
rail-statements, protocol and its TEST wallet provider, indexer, trade, ws, the TEST venue adapter, NATS, Postgres and the
TEST chain. Every other service stays in the repo and in CI, and is off here: its health row reads `off`, and edge answers
its routes as not connected here (`EDGE_UPSTREAMS_OFF`), which the app says plainly. `status` names each running process
and their count.

**While testers are on** (anyone invited has opened the TEST mailbox, `~/.intafaced/beta/invited.json`), each move
restarts the stack and sends every open tab to the updating page, so main moves only once a day, at the first round after
the daily slot (20:00 UTC, 04:00 in Bali; `BETA_MOVE_AT=HH:MM` in the service's environment sets another), or on demand
(`beta-host.mjs move`, which the supervisor picks up within 15 seconds). With nobody invited it follows main each round.
A moved commit that fails its install, its launch, the TEST funds check or readied goes back to the last commit that came
up, behind the updating page, and that commit is refused, even on demand, until main moves past it
(`~/.intafaced/beta/served.json`; #11029).

**While it updates:** the update rebuilds and restarts the stack in its one checkout, which takes about five minutes on
the box. From before the checkout moves until the new stack passes the TEST funds check and Markets lists priced markets,
`status.json` reads `updating`, and the front answers every page load with a short "Updating the beta" page that reloads
itself; an open app tab reloads onto it within 15 seconds. A launch on a stack that is up and readied changes nothing a
tester sees. When the app refuses, or the status is `down`, `refused` or `blocked`, a page load gets "The beta is
resting" instead of a browser error. A second stack readied beside the first would avoid the wait, at twice the build and
memory on a box that is already loaded.

**Who can open it (the allow list):** the stack listens only on the box's own loopback, and nothing on the home
network can reach it. The only way in from outside is a Cloudflare Tunnel, which the box dials out. Cloudflare Access sits
in front of both names: a one-time PIN mailed to an email on the invite list, and nobody else gets past the login. The
tunnel itself also refuses any request that does not carry an Access token for its app (cloudflared's
`originRequest.access`), so a request can't skip the login even if the Access app were removed.

| Piece                                          | On the box                                                                                                              | What it does                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `intafaced-beta-tunnel.service` (systemd user) | `~/.local/bin/cloudflared`, config `~/.cloudflared/intafaced-beta.yml`, credentials beside it (mode 600)                | `beta.intafaced.com` → `127.0.0.1:6211`, `beta-mail.intafaced.com` → `127.0.0.1:6291`, anything else 404 |
| `intafaced-beta-front.service` (systemd user)  | `~/.intafaced/beta/checkout/tooling/beta/beta-front.mjs`; `serve` writes its unit and restarts it when the file changes | maps the public origin onto the stack's loopback names (below); shows the updating page                  |
| `intafaced-beta.service`                       | `tooling/beta/beta-host.mjs serve`                                                                                      | the stack itself, unchanged                                                                              |

**Why the front:** the stack knows only its loopback origin. Its Customer server refuses any other `Host`, and Edge and
svc-ws accept only `http://localhost:6210` as an `Origin`. The front rewrites the `Host`, and rewrites the `Origin` only
when it is exactly `https://beta.intafaced.com`, so a cross-site call is still refused. It points loopback redirects and the
mailbox's links at the public name, and strips Access's token before the stack sees it. Nothing in the stack's environment
changes, so the TEST funds check below stays as strict as before. Test: `node --test tooling/beta/beta-front.test.mjs
tooling/beta/beta-round.test.mjs`.

**The Cloudflare side** (the `intafaced.com` zone, the tunnel `intafaced-beta`, the two Access apps and their invite
list) is set by the owner's agents with his Cloudflare key, which lives outside this repository.

**TEST funds only, shown by a check:** after every round, `beta-host.mjs check` reads the environment of every process
the stack started and fails when any address names a host other than this machine, so no service has a route to a real
chain, venue, bank or card rail. It also checks that the page carries the TEST banner. A failed check stops the stack.
Blank prices and limits refuse, as on every test stack. Every rail is a TEST stand-in (`docs/LOCAL-TEST-STACK.md`).

## Sign in as a test customer, on the phone

1. Open `https://beta.intafaced.com/`. Cloudflare asks for your email. Enter an invited one, then type the 6-digit code
   Cloudflare mails you. You stay signed in for a week on that browser.
2. Open `https://beta-mail.intafaced.com/` in a second tab. The TEST mailbox names your token (your login email, with
   every other character a dash, then a short code of it) and shows only mail to TEST addresses that start with it, so each person sees only the
   codes for the accounts they created. Back in the app, tap **Sign up**. Enter an email that is your token, or your
   token, a dot and anything (for example `alice-gmail-com-1a2b3c4d5e.1@local-test.invalid`), a handle, a password of your choice,
   a country, "No, I am not a US person", and a birth date. Tap **Create account**.
3. The app asks for the code from the email. The mailbox tab shows the newest code for your address. Type it in and tap **Confirm and open my account**. A new browser signing in
   later is asked for a device code: it is in the same mailbox.
4. You are on Home, in Volt, dark. To unlock the rooms that need a verified person, open **Verification**, request
   **Full**, enter any country code, and submit. Within a minute the stack's TEST approvers approve it and 1000 TEST
   USDT reach the account, with nobody in the loop (below). Sign out and in once so the app sees it, then trade.

Everything you see is TEST: prices, balances and limits carry the TEST label, and nothing can move real money.

**Invited testers are approved and funded automatically** (`tooling/beta/beta-invited.mjs`, #10243). The front passes
each Access-verified viewer's token to the mailbox, and the mailbox records it in `~/.intafaced/beta/invited.json`;
every invited person opens the mailbox for their sign-up code. Every 15 seconds `serve` runs one pass: an account whose
address is a recorded token, or the token, a dot and more, at `local-test.invalid` has its pending Full (or Basic)
request approved through the stack's two-person TEST door, and once it holds Full gets 1000 TEST USDT through the real
ledger, once per account (a fixed ledger reference) and for at most 3 accounts per person
(`~/.intafaced/beta/granted.json`; the agents' own invite, whose walks each sign up anew, is not capped, #11104). The same 1000 TEST USDT is kept in that account's TEST partner account, where the
launch model holds a person's money and which Home and Money read (#10632); every pass puts it back after an svc-bank
restart, as that person, while they are signed in, and the beta starts svc-ops with `LOCAL_STACK_VALUATION_PRICES=test`
(the ops profile's labelled TEST price list, `USDC=1,USDT=1`) so Home and Money value that holding with a TEST total.
Once such an account has made its own embedded wallet (`/wallet/embedded`), the same pass sends 25 TEST USDC to that
wallet on Hyperliquid's TEST network, for the futures desk (`tooling/beta/beta-testnet.mjs`, #10842): it reads the
address through svc-protocol's `protocol.embeddedWallet.status` record as that person, and dispatches
`hl-testnet-send.yml` on main with `gh`, so the funded testnet key stays in CI and never comes to the box. Once per
account and address, for at most 3 accounts per person (`~/.intafaced/beta/testnet-funded.json`, written before each
dispatch), one send at a time; a failed dispatch or run is tried again after 5 minutes, 3 tries in all; a send whose
run id was lost waits 20 minutes, or until the address shows the funds, before it counts as failed, so a crash makes
a tester wait, never a second send. Below 25 free TEST USDC at the funder, nothing is sent and `round.log` says so once.
Any other account, uninvited or made on the box, gets nothing. The pass's lines are in `round.log`. Test, on the box: `node tooling/beta/beta-host.mjs invited-test --checkout ~/.intafaced/beta/checkout
--watch`, run as below.

**Approve or fund anyone else (an agent, on the box).** Run these under the user's systemd manager, as the stack runs.
An agent's own shell may not read the stack's processes, and then the tools refuse with "not active".

```sh
B=~/.intafaced/beta
run() { systemd-run --user --quiet --wait --pipe --collect -p WorkingDirectory=$B/checkout \
  --setenv=LOCAL_STACK_SLOT=3 --setenv=LOCAL_STACK_STATE=$B/state /bin/bash -lc "$1"; }
run 'node tooling/scripts/local-test-gates.mjs verify'                        # if a request still waits: TEST operators approve it now
run 'node tooling/scripts/local-test-stack.mjs fund <email> USDT 1000'        # TEST USDT through the real ledger
```

**Passkeys and wallet messages** work on the public name only: the beta starts the stack with
`LOCAL_STACK_PUBLIC_ORIGIN` set to it, so svc-identity's relying party is `beta.intafaced.com`, and the TEST wallet
provider and svc-protocol's wallet messages accept that origin. A sign-in passkey made there does not work on the box's
`localhost` page.

**Known gaps on the public name:** the TEST bank pay-in's return link and the academy's videos point at the box's loopback.

## Check a trading change on the test network, no browser

`node tooling/beta/hl-drive.mjs <setup|status|spot|perp|move-stop|cancel|close|flatten>` on the box (#11060), under the
user's systemd manager so the stack's tools can read its processes:
`systemd-run --user --pipe --wait --quiet -p WorkingDirectory=$PWD node tooling/beta/hl-drive.mjs perp`. It signs in as
its own TEST customer on the beta stack and sends what the desk sends through our doors, signed by a test key kept in
`~/.intafaced/beta/hl-drive/` (mode 600), never printed. Each action prints our door's answer beside the venue's own
record. It refuses any venue but Hyperliquid's test network. `setup` makes the account and key once; fund the printed
address with `hl-testnet-send.yml`. The file's header lists each action's options.

## When it is not up

- **`blocked`: no TEST screening file.** Edge refuses every call until a sanctions screening list is set, and no agent
  invents one. The owner's approved TEST fixture lives in the repository secrets `INTAFACED_SANCTIONS_REGIONS` and
  `INTAFACED_SANCTIONS_LIST_SOURCE`; by his decision (`tooling/ci/ci-review/REVIEW.md`, entry of 2026-11-22) an agent
  dispatches `beta-screening-seal.yml`, which seals them to the box's key `tooling/beta/seal.pub.pem`, downloads the
  artifact and decrypts it, unseen, into `~/.intafaced/beta/state/screening.local.json` (mode 600,
  `{"regions": "...", "source": "..."}`, the same file `docs/LOCAL-TEST-STACK.md` names). The next round starts the
  stack.
- **The owner's vendor keys** (his wallet provider's `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY`,
  `TURNKEY_API_PRIVATE_KEY`, and his screening vendor's `OPENSANCTIONS_API_KEY`; his decision is cited in the workflow's
  header) reach the box the same way, unseen: make a fresh RSA-4096 key on the box (`~/.intafaced/beta/seal/seal.key`,
  mode 600) and commit its public half as `tooling/beta/seal.pub.pem`; once that is on main, dispatch
  `beta-screening-seal.yml`, download its artifact, decrypt `key.enc` with that key and `vendors.enc` with the result,
  under `umask 077`, straight into `~/.intafaced/beta/state/vendors.local.json`; then delete the key and the download.
  Show only that each name is set, never a value. No service reads them until a start asks: svc-identity and
  svc-protocol with `LOCAL_STACK_PROTOCOL_EMBEDDED_WALLET=turnkey`, svc-pay with `LOCAL_STACK_PAY_SCREENER=opensanctions`.
  The beta's wallet provider is one setting, `BETA_WALLET_PROVIDER` in `beta-host.mjs` (#11092): `test` until testers
  are invited, so our own walks spend none of his provider's free signatures, and while it is `test` the TEST mailbox
  refuses every new invitee (403, never recorded, so never approved or funded) and `beta-host.mjs status` says
  `new wallets at the TEST provider; invites refused`. To open the invites: the paid plan first (his), then
  `BETA_WALLET_PROVIDER = 'turnkey'` in one PR, then one walk that passes on it before the first invite. A tester's
  existing wallet keeps signing where it was made. It leaves the
  screening vendor's switch off: with the TEST list, the vendor clears no custodial send.
- **`down`:** the reason names the step; the round's log is `~/.intafaced/beta/round.log`. The next round tries again.
- **`refused`:** the TEST funds check found a route off the machine; the stack stays stopped until a change on main
  removes it.

- **The link shows a Cloudflare error (502 or 1033):** `systemctl --user status intafaced-beta-tunnel.service
intafaced-beta-front.service`; the tunnel's log names its connections (`journalctl --user -u intafaced-beta-tunnel`).

Install once on the box, from the beta checkout: `node ~/.intafaced/beta/checkout/tooling/beta/beta-host.mjs install`.
The beta's units (supervisor and stack, front, tunnel by a drop-in) run at CPU and IO weight 1000, ahead of builders,
and the stack keeps 2G under memory pressure; each round keeps them so (`syncPriority`, #11062). Check:
`systemctl --user show intafaced-beta.service intafaced-beta-front.service intafaced-beta-tunnel.service -p CPUWeight -p IOWeight -p MemoryLow`.
Stop: `systemctl --user stop intafaced-beta.service`, then `node tooling/beta/beta-host.mjs stop`.
Close the public door alone: `systemctl --user disable --now intafaced-beta-tunnel.service`.
