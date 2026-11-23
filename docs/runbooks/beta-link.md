# The beta link

The Customer app on the latest `main`, always on, on TEST funds only, for the owner's beta walk and the people he invites (#9346).

- **Link:** `https://beta.intafaced.com/`, behind a login only invited emails pass
- **TEST mailbox** (the codes the app sends): `https://beta-mail.intafaced.com/`, behind the same login
- **On the box itself:** `http://localhost:6210/` and `http://localhost:6290/`
- **State now:** `node tooling/beta/beta-host.mjs status` on the box (`~/.intafaced/beta/status.json`): `up` with the
  main commit it shows, `blocked` or `down` with the reason.

## How it works

One copy of the local test stack (`tooling/scripts/local-test-stack.mjs`) runs on the Linux box, in its own checkout of
`origin/main` (`~/.intafaced/beta/checkout`), its own state folder (`~/.intafaced/beta/state`) and slot 3, so its ports
never move. The systemd user service `intafaced-beta.service` runs `tooling/beta/beta-host.mjs serve`, which every 30
minutes fetches main and runs `verify launch`, which readies the stack the way a journeys shard is readied and restarts
what is down. At most once every 2 hours it first moves the checkout to main and installs, so the launch rebuilds what
changed: a merge to main is on the link within about two and a half hours. The mailbox page names the commit served.

**Who can open it (the allow list):** the stack listens only on the box's own loopback, and nothing on the home
network can reach it. The only way in from outside is a Cloudflare Tunnel, which the box dials out. Cloudflare Access sits
in front of both names: a one-time PIN mailed to an email on the invite list, and nobody else gets past the login. The
tunnel itself also refuses any request that does not carry an Access token for its app (cloudflared's
`originRequest.access`), so a request can't skip the login even if the Access app were removed.

| Piece                                          | On the box                                                                                               | What it does                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `intafaced-beta-tunnel.service` (systemd user) | `~/.local/bin/cloudflared`, config `~/.cloudflared/intafaced-beta.yml`, credentials beside it (mode 600) | `beta.intafaced.com` → `127.0.0.1:6211`, `beta-mail.intafaced.com` → `127.0.0.1:6291`, anything else 404 |
| `intafaced-beta-front.service` (systemd user)  | `tooling/beta/beta-front.mjs`                                                                            | maps the public origin onto the stack's loopback names (below)                                           |
| `intafaced-beta.service`                       | `tooling/beta/beta-host.mjs serve`                                                                       | the stack itself, unchanged                                                                              |

**Why the front:** the stack knows only its loopback origin. Its Customer server refuses any other `Host`, and Edge and
svc-ws accept only `http://localhost:6210` as an `Origin`. The front rewrites the `Host`, and rewrites the `Origin` only
when it is exactly `https://beta.intafaced.com`, so a cross-site call is still refused. It points loopback redirects and the
mailbox's links at the public name, and strips Access's token before the stack sees it. Nothing in the stack's environment
changes, so the TEST funds check below stays as strict as before. Test: `node --test tooling/beta/beta-front.test.mjs`.

**The Cloudflare side** (the `intafaced.com` zone, the tunnel `intafaced-beta`, the two Access apps and their invite
list) is set by the owner's agents with his Cloudflare key, which lives outside this repository.

**TEST funds only, shown by a check:** after every round, `beta-host.mjs check` reads the environment of every process
the stack started and fails when any address names a host other than this machine, so no service has a route to a real
chain, venue, bank or card rail. It also checks that the page carries the TEST banner. A failed check stops the stack.
Blank prices and limits refuse, as on every test stack. Every rail is a TEST stand-in (`docs/LOCAL-TEST-STACK.md`).

## Sign in as a test customer, on the phone

1. Open `https://beta.intafaced.com/`. Cloudflare asks for your email. Enter an invited one, then type the 6-digit code
   Cloudflare mails you. You stay signed in for a week on that browser.
2. Tap **Sign up**. Enter any email ending in `@local-test.invalid` (for example `nino1@local-test.invalid`), a handle,
   a password of your choice, a country, "No, I am not a US person", and a birth date. Tap **Create account**.
3. The app asks for the code from the email. Open `https://beta-mail.intafaced.com/` in a second tab: the TEST mailbox
   shows the newest code for your address. Type it in and tap **Confirm and open my account**. A new browser signing in
   later is asked for a device code: it is in the same mailbox.
4. You are on Home, in Volt, dark. To unlock the rooms that need a verified person, open **Verification**, request
   **Full**, enter any country code, and submit: the stack's TEST operators approve it within a minute. Sign out and in
   once so the app sees it. TEST funds are added by an agent (below).

Everything you see is TEST: prices, balances and limits carry the TEST label, and nothing can move real money.

**Approve and fund a TEST person (an agent, on the box).** Run these under the user's systemd manager, as the stack runs.
An agent's own shell may not read the stack's processes, and then the tools refuse with "not active".

```sh
B=~/.intafaced/beta
run() { systemd-run --user --quiet --wait --pipe --collect -p WorkingDirectory=$B/checkout \
  --setenv=LOCAL_STACK_SLOT=3 --setenv=LOCAL_STACK_STATE=$B/state /bin/bash -lc "$1"; }
run 'node tooling/scripts/local-test-gates.mjs verify'                        # if a request still waits: TEST operators approve it now
run 'node tooling/scripts/local-test-stack.mjs fund <email> USDT 1000'        # TEST USDT through the real ledger
```

**Known gaps on the public name:** passkeys stay off, because the stack's passkey domain is `localhost`. The TEST bank
pay-in's return link and the academy's videos point at the box's loopback. On a phone-width screen the desk's order-type
tabs overlap, so "OTO" covers "Market".

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

- **The link shows a Cloudflare error (502 or 1033):** `systemctl --user status intafaced-beta-tunnel.service
intafaced-beta-front.service`; the tunnel's log names its connections (`journalctl --user -u intafaced-beta-tunnel`).

Install once on the box, from the beta checkout: `node ~/.intafaced/beta/checkout/tooling/beta/beta-host.mjs install`.
Stop: `systemctl --user stop intafaced-beta.service`, then `node tooling/beta/beta-host.mjs stop`.
Close the public door alone: `systemctl --user disable --now intafaced-beta-tunnel.service`.
