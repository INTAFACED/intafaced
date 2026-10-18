# Licence position — what must be resolved before launch

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** engineering record, 2026-07-29, against commit `4311cff`.
**Companion:** [`NOTICE`](../NOTICE) at the repository root — the evidence. This file is the decisions.
**Tip freshness (2026-08-15, D26-P3-04):** §§ below are still that compile. Working-tree facts that diverged are named in `NOTICE` §11 and pinned by `tooling/ci/notice-pin.mjs`. This is not a new legal opinion. The 2017 Charting Library copy is **gone from the working tree** (Path A, #106); history may still hold it. **Owner 2026-08-31:** intended live chart is **TradingView Advanced Charts**, waiting on TradingView access/approval — see §1.1a. Undetermined jars, Geetest, and other §10 rows are unchanged asks for counsel — agents do not close them.

> **This is not legal advice.** It is an engineering audit of what is in the tree and what each
> artefact says about itself. Nothing here clears anything. Several items below need a lawyer, and
> the point of writing them down is so that the lawyer is asked the right questions and is not the
> one who has to go find the files.

## What was audited

| Scope                                                 | Count                                      |
| ----------------------------------------------------- | ------------------------------------------ |
| Files redistributed under `vendor/upstream-exchange/` | 1,822 tracked                              |
| Distinct third-party components inventoried           | 43 itemised in `NOTICE` §1–§9              |
| Committed `.jar` binaries                             | 31 files, 8 distinct artefacts             |
| Maven coordinates declared across 31 POMs             | 91                                         |
| Node packages resolved in the pnpm workspace          | 250, from 37 declared deps in 29 manifests |
| Container images declared in compose                  | 12                                         |

Method, and the only reason this document is worth anything: **every licence recorded was read from
the artefact itself** — the jar's embedded POM, the file's banner, the font's metadata — or from the
published POM of the exact version the build resolves, fetched from `repo1.maven.org`. Nothing was
inferred from a project's reputation. Where nothing could be read, the entry says UNDETERMINED and
lists what was checked. `NOTICE` §10 indexes all 23 such entries.

---

## Priority 1 — Genuine blockers. Launch is not lawful until these are resolved.

### 1.1 · TradingView Charting Library is proprietary and we have no licence

**DECISION 2026-07-29 — Path A.** Hold TERMINAL.md (lightweight-charts). Charting Library purged from the product shell; chart rewired to lightweight-charts. See `docs/OWNER-DECISIONS-OPEN.md`. History rewrite (optional): `tooling/scripts/purge-charting-library-history.sh`.

**What.** `vendor/upstream-exchange/05_Web_Front/src/assets/js/charting_library/` — 85 files, 5.4 MB, all
git-tracked. Version string read from the artefact: `1.11 (internal id fe319232 @ 2017-11-14)`.

**The finding.** There is **no licence file, no NOTICE, no EULA and no copyright header anywhere in
those 85 files.** The Charting Library is licensed software. TradingView grants it to a named
licensee under their own agreement; it is not open source and it is not sublicensable. The
Apache-2.0 grant covering the upstream exchange (`vendor/upstream-exchange/LICENSE`) cannot convey it,
because the upstream author did not own it. It arrived bundled with someone else's project and we
inherited a copy, not a right.

**Risk if unresolved.** We are redistributing a third party's commercial product in a git repository.
Deleting the directory does not delete it from history. For a regulated financial venue, an
infringement claim from a well-resourced rights holder is not merely a cost — it is a disclosure
event, and it lands on the exact surface (the trading chart) that a customer sees.

**Compounding factor, and this one is worse than the licence.** The vendored front end **fetches the
Charting Library bundles at runtime from the upstream operator's Alibaba Cloud OSS bucket** —
`library.<hash>.js`, `vendors.<hash>.js`, `spin.min.js` — hard-coded in
`static/bundles/library.52f448f933885e5e0fed.js` and `static/tv-chart.*.html`. That is arbitrary
remote JavaScript, executing in our users' browsers, served from a bucket controlled by an operator
the upstream README describes as having ceased trading. Whoever controls that bucket today controls
our chart. This is a security finding that happens to have been found during a licence audit.

**Action, in order.**

1. **Decide whether we want it at all.** [`docs/TERMINAL.md`](TERMINAL.md) already specifies the
   INTAFACED pro terminal charting on **lightweight-charts, Apache-2.0** — a different TradingView
   product with a genuinely permissive licence, and no application required. If that decision holds,
   the Charting Library is not needed and 1.1 collapses into 1.2 (purge). This is the cheapest path
   and it is already the documented plan.
2. **If it is wanted:** apply to TradingView at <https://www.tradingview.com/advanced-charts/> for
   Advanced Charts, and read the agreement they present rather than anything summarised here. The
   grant runs to a named licensee, so it must be requested by INTAFACED. Assume the round trip is
   measured in days, not minutes, and that it gates launch. It should be started this week whichever
   way 1.1 goes, because the answer to "how long does it take" is itself unknown.
3. **Regardless of 1 and 2:** cut the runtime OSS-bucket fetch today. It needs no legal input.

**Who acts.** Denon decides 1 (it is an architecture call already made in `TERMINAL.md`). Nitro or
Denon submits 2 — it is a commercial application, not an engineering task. Engineering does 3 now.

### 1.1a · Owner 2026-08-31 — Advanced Charts is the intended host (approval pending)

**Owner (Nitro, this session):** the product chart is **TradingView Advanced Charts**, not a permanent Lightweight Charts substitute and not a third-party drawing pack. Path A (LWC on tip, 2017 Charting Library purged) stays as **interim + hygiene**. It is not the end state.

**Names (official 2026-08-18 docs, do not mix):**

| Product                        | What it is                                                                                                                                                                                                                                                                                                           | Use here                                                                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Advanced Charts**            | Proprietary client library. Drawings, 100+ indicators, compare, theming. **Our datafeed.** Stated free **if** TV attribution stays visible **and** the environment is public (not private / not behind a paywall). Access = TradingView GitHub invite. **Not redistributable** — must not land in a public git repo. | **Intended desk chart.** SOCKET until access + counsel read of the actual agreement.                                                                                                                             |
| **Trading Platform**           | Paid. Everything in Advanced Charts **plus** multi-chart layouts (up to 8), trade-from-chart, Broker API, Account Manager, TV DOM, watchlist widgets.                                                                                                                                                                | **Not chosen.** Multi-chart linking and trade-from-chart in M07 need this product, not Advanced Charts. Do **not** silently upgrade. Name the hole if M07-R01/R02 multi-chart or chart-ticket is still required. |
| **Lightweight Charts™**        | Apache-2.0, already vendored 5.2.1.                                                                                                                                                                                                                                                                                  | **Interim** host until Advanced Charts mounts. Honesty/overlays/as-of still ship on it.                                                                                                                          |
| **Widgets (iframe)**           | TradingView’s data, not ours.                                                                                                                                                                                                                                                                                        | **Never.**                                                                                                                                                                                                       |
| **2017 Charting Library copy** | Unlicensed bytes purged #106; remote OSS-bucket fetch was a security hole.                                                                                                                                                                                                                                           | **Never restore.** Apply for a **current** Advanced Charts grant.                                                                                                                                                |

**Still unsupported even after Advanced Charts approval** (official: client libraries have no TV.com server features): **Pine Script, Alerts, Bar Replay, TV market data, Strategy Tester.** M07 “alerts” and “replay” stay refuse-or-our-own-capture — do not fake them with a badge.

**Engineering until approval:** do not clone the private repo, do not npm a pirate copy, do not commit library files to `intafaced`. Keep LWC. After approval: private/non-public install path, our OHLCV/WS datafeed, N4 theme via official theming, attribution visible, Vue host **inside Bazaar** (no second SPA).

**Counsel still reads the agreement they present.** Login-gated `/exchange` may fail the “public / not behind a paywall” free-use test. That is Class X, not an agent close.

---

### 1.2 · Six of eight committed jars have no licence, and one of them holds keys

**What.** 31 `.jar` files are committed under `vendor/upstream-exchange/` and wired into POMs with
`<scope>system</scope>`, so the build uses the committed bytes and never resolves a coordinate.

**Resolved from the previous audit's "6 of 8 unidentifiable".** Every jar was opened. Every one
carries an embedded Maven POM, which is more than the previous pass established. That yields real
identifiers — groupId, builder, build date, private repository host — for all eight. It does **not**
yield licences.

| Artefact                                         | Identified                              | Licence             |
| ------------------------------------------------ | --------------------------------------- | ------------------- |
| `com.cdeer:apns-http2-core:1.3`                  | APNs HTTP/2 client, built 2018-04-19    | **UNDETERMINED**    |
| `com.aqmd:aqmd-netty:2.0.1`                      | vendor claim `www.aqmd.com` in manifest | **UNDETERMINED**    |
| `com.aqmd:aqmd-netty-api:2.0.1`                  | vendor claim `www.aqmd.com`             | **UNDETERMINED**    |
| `com.aqmd:aqmd-netty-core:2.0.1`                 | vendor claim `www.aqmd.com`             | **UNDETERMINED**    |
| `com.sparkframework:spark-core:2.6.0`            | private framework, private Nexus        | **UNDETERMINED**    |
| `com.spark.bc:bitcoin-rpc:1.2.0`                 | POM `<name>hot-wallet</name>`           | **UNDETERMINED**    |
| `org.bitcoinj:bitcoinj-core:0.13-alice-SNAPSHOT` | local build of a fork                   | Apache-2.0 declared |
| `org.litecoinj:litecoinj-core:0.15.20190219`     | local build of a fork                   | Apache-2.0 declared |

**Hard fact that closes the question.** Maven Central was queried for all four groupIds
(`com.aqmd`, `com.sparkframework`, `com.spark.bc`, `com.cdeer`): **numFound 0**. None of them exists
publicly. The artefact names `bitcoin-rpc`, `aqmd-netty` and `apns-http2-core` do not exist on
Central under any groupId. These are not obscure open-source libraries we failed to find. They are
private artefacts from private repositories, and the absence of a licence in them is the expected
state of private artefacts, not an oversight we can read past.

Two of the eight are the worst of the set for different reasons:

- **`com.aqmd:*`** carry an _affirmative vendor claim_ in `MANIFEST.MF`
  (`Implementation-Vendor: www.aqmd.com`). A named corporate owner and no grant means exclusive
  rights reserved. This is not ambiguity; it is a licence we do not have.
- **`com.spark.bc:bitcoin-rpc`**, POM name `hot-wallet`, is on the classpath of **all 14 wallet RPC
  modules** — the services that hold private key material for BTC, ETH, USDT, LTC, EOS and others.
  It cannot be verified against a published checksum because no published artefact exists. The
  licence question here is genuinely the _second_ problem.

**Risk if unresolved.** Redistributing six unlicensed binaries. Separately and more urgently: an
unauditable binary of unknown authorship with access to key material, which no amount of licence
paperwork would make acceptable.

**Action.** These jars should be **replaced with declared Maven coordinates or removed**, which is
the same conclusion `docs/adr/2026-07-28-upstream-exchange-integration.md` §4 reached from the security
side. Where no public equivalent exists — and for the four private ones, none does — the calling
code has to be rewritten or the module dropped. Treat `bitcoin-rpc` first.

**Who acts.** Denon. This is a build-and-architecture change, not a paperwork exercise.

---

### 1.3 · MySQL Connector/J is GPLv2 in a proprietary product

**What.** `mysql:mysql-connector-java:8.0.11`, declared in `vendor/upstream-exchange/00_framework/pom.xml`
and resolved into every Java service that talks to the database.

**Evidence.** Read from `mysql-connector-java-8.0.11.pom` on Maven Central:

```
<name>The GNU General Public License, v2 with FOSS exception</name>
```

**Why this is a blocker and the others in §7 are not.** The FOSS Exception permits linking from
software distributed under an _enumerated list_ of free licences. A proprietary, closed-source
financial product is not on that list. Absent the exception, plain GPLv2 applies to a work that
links the driver. Oracle sells a commercial licence for precisely this situation, which is itself
evidence of how they read it.

**Risk if unresolved.** The strongest copyleft claim in the tree, held by a rights holder with an
established commercial licensing programme and a history of enforcement.

**Action, cheapest first.**

1. **Swap the driver.** **DONE 2026-07-29** — MariaDB Connector/J **2.7.12** (LGPL-2.1) replaces `mysql-connector-java:8.0.11` across the Java framework POMs; driver class is `org.mariadb.jdbc.Driver`.
2. If the driver cannot be swapped, buy the Oracle commercial licence.
3. Note that this is independent of the `mysql:8.0` **server** image (§9 of `NOTICE`) — running the
   GPLv2 server as a separate process over a network protocol is the ordinary compliant posture and
   is not the issue here. The _driver_ is what links into our code.

**Who acts.** Denon for option 1. If option 1 fails, it escalates to Nitro as a purchase.

---

## Priority 2 — Must be answered before launch, but not on the critical path

### 2.1 · Geetest appears twice, once with its attribution removed

`vendor/upstream-exchange/05_Web_Front/src/assets/js/gt.js` carries a bare copyright line
(`// "v0.4.6 Geetest Inc.";`) and no grant. Its server-side counterpart is worse: the Java SDK has
been copied into the upstream project's **own package namespace** at
`00_framework/ucenter-api/src/main/java/com/upstream/job-module/system/GeetestLib.java`, with the original
header stripped. Its Javadoc reads, in full, `Java SDK`. It is identifiable only by its API
endpoints (`api.geetest.com`, `/register.php`, `/validate.php`).

**Why it matters beyond this one file.** A vendor SDK re-namespaced with its header removed is
outside any grant the upstream could make, _and_ it is the category of finding that proves the
Apache-2.0 root LICENSE cannot be trusted as a blanket answer for this tree. Where one exists,
others may.

**Risk.** Redistributing a commercial vendor's SDK with attribution removed; using a paid
verification service with no account and no agreement.

**Action.** Both captcha paths are replaced by our own identity stack — see
`docs/adr/` and the identity service. Remove `gt.js`, `GeetestLib.java` and the surrounding
`GeeTest*` integration rather than licensing them. Also remove the unconditional
`<script src="https://ssl.captcha.qq.com/TCaptcha.js">` in `05_Web_Front/index.html` (§6.1 of
`NOTICE`) — a second third-party captcha, loaded remotely, also with no agreement.

**Who acts.** Denon.

---

### 2.2 · Fonts and icon sets — four items, none with terms in the file

| Item                                            | Established from the artefact                            | Missing               |
| ----------------------------------------------- | -------------------------------------------------------- | --------------------- |
| Font Awesome web font (inside charting library) | `<font id="fontawesomeregular">`; `<metadata>` **empty** | version _and_ licence |
| Ionicons (admin + front end)                    | metadata: "By Adam Bradley", FontForge 2014-12-04        | licence               |
| `iconfont.{eot,svg,ttf,woff,woff2}`             | metadata: "Created by iconfont", 2013-09-30              | **all provenance**    |
| `mui.ttf`                                       | nothing                                                  | **all provenance**    |

Font licensing is genuinely different from code licensing: several common icon fonts ship the font
files under SIL OFL and the accompanying CSS under MIT, and the terms have changed across major
versions. Because the Font Awesome artefact states **no version**, the applicable terms cannot be
derived from it — they have to be established by matching the files against a published release.

`iconfont.*` is the one that cannot be fixed by research. It was assembled by an online icon tool
from a catalogue of separately-uploaded glyphs; the tool records no per-glyph author and no per-glyph
licence, so the font carries none, and per-glyph provenance is **not recoverable**. At least one
glyph is a named third-party messaging brand's mark, which is a trademark question sitting on top of
the copyright one.

**Risk.** Low-probability, low-severity individually. Collectively it is the kind of finding that
makes an acquirer's or regulator's diligence report read badly, because it shows nobody looked.

**Action.** Do not research these. Replace them. `packages/ui` owns iconography, and every one of
these four is inside the vendored front end, which is scheduled for replacement anyway. Deletion is
cheaper than provenance archaeology and it is the only reliable answer for `iconfont` and `mui.ttf`.

**Who acts.** Denon, folded into the front-end replacement.

---

### 2.3 · `jxl` (LGPL) and `logback` (EPL/LGPL dual)

- **`net.sourceforge.jexcelapi:jxl:2.6.10`** — published POM declares "GNU Lesser General Public
  License". Weak copyleft. Dynamic linking without modification is the ordinary compliant pattern,
  but LGPL imposes real obligations on a _distributed binary_ (relinking, library source
  availability) that a proprietary product must actually satisfy rather than assume. It is used for
  spreadsheet export in the admin console. Replacing it with Apache-2.0 Apache POI removes the
  question.
- **`ch.qos.logback:*:1.1.11`** — parent POM declares EPL-1.0 **or** LGPL, at the recipient's
  election. Electing EPL-1.0 is the ordinary choice for proprietary use and is not a blocker. It
  should be **recorded as a deliberate election**, because an unrecorded dual licence is a question
  someone will ask twice.

**Who acts.** Denon (jxl swap). The logback election is a one-line note back into `NOTICE`.

---

### 2.4 · `@img/sharp-win32-x64` — the only non-permissive Node package

Out of **250 resolved packages**, exactly one is not permissive:
`@img/sharp-win32-x64@0.34.5`, declared `Apache-2.0 AND LGPL-3.0-or-later`. The LGPL component is
the bundled `libvips` native library; `sharp` itself is Apache-2.0. It arrives as an optional
dependency of Next.js image optimisation, not as a choice of ours.

LGPL, not GPL — it does not reach our source. It does impose obligations on a distributed binary.
Only the `win32-x64` variant appears because pnpm filters by platform; a Linux image build resolves
the corresponding Linux variant under the same terms.

**There is no GPL, AGPL or SSPL anywhere in the resolved Node tree.** That is a good result and it
is the one part of this audit that needs no action beyond keeping it true.

**Action.** Add a CI licence gate that fails on GPL/AGPL/SSPL in the Node tree, so this stays a
one-line entry rather than becoming a discovery in six months. Decide separately whether Next.js
image optimisation is used at all; if not, the dependency can be dropped.

**Who acts.** Denon.

---

## Priority 3 — Record the position; no work needed unless something changes

### 3.1 · Grafana and Tempo are AGPL-3.0

Verified at the pinned tags — the `LICENSE` file at `v11.4.0` (grafana) and `v2.6.1` (tempo) both
begin "GNU AFFERO GENERAL PUBLIC LICENSE Version 3". Declared in `docker-compose.yml` lines 113 and
88, for local development observability.

AGPL §13 obliges offering Corresponding Source to users who interact with a **modified** version
over a network. We run both **unmodified**, for our own developers, and ship neither. That is
outside §13.

**It stops being outside §13** the moment anyone (a) patches either image, or (b) exposes a Grafana
instance to customers as part of the product. Both are plausible: an embedded status dashboard is
exactly the kind of feature that gets built without anyone re-reading the licence.

**Action.** None now. Record it, and re-open if either trigger occurs.

### 3.2 · MySQL server and MongoDB server images

`mysql:8.0` (GPLv2 server, distinct from the Connector/J driver at 1.3) and `mongo:6` (SSPL) are run
as infrastructure alongside the vendored platform — separate processes, network protocols, not
linked into our code, not redistributed. That is the ordinary compliant posture for both licences.
**Neither was verified at the pinned tag in this pass**, and both are recorded in `NOTICE` §9 as
open questions rather than as findings. The compliant posture depends on facts about how we deploy,
so it should be stated deliberately rather than assumed.

### 3.3 · Elasticsearch 5.3.3 predates the SSPL relicensing

`org.elasticsearch.client:transport:5.3.3` — the published 5.3.3 POM declares Apache-2.0, and that
is what applies to this artefact. Elasticsearch moved to SSPL/Elastic Licence in 2021, from 7.11.
**Any upgrade past 7.10 changes the answer.** Recorded so that a future dependency bump does not
silently import SSPL.

### 3.4 · protobuf-java is BSD-3-Clause, not Apache-2.0

`com.google.protobuf:protobuf-java` — parent POM declares "3-Clause BSD License". Both are
permissive and nothing turns on it. It is recorded because it is the single clearest illustration of
why this audit refused to infer licences from reputation: protobuf is very widely and very
confidently misattributed as Apache-2.0, including by people who have shipped it for years.

---

## What was deliberately left alone

- **`vendor/upstream-exchange/LICENSE` and `vendor/upstream-exchange/NOTICE`** — unmodified. They are the
  upstream provenance record. The root `NOTICE` adds to them and cites them; it does not correct or
  replace them.
- **The vendored source tree itself.** No file under `vendor/upstream-exchange/` was edited, moved or
  deleted. Everything in Priority 1 and 2 is a _recommendation_; acting on it is a separate,
  reviewable change. An audit that also performs the remediation is an audit nobody can check.
- **The upstream's CJK-script copyright holder name** in `04_Web_Admin/LICENSE`. It is not
  transliterated into the root `NOTICE`. Transliterating a copyright holder's name is rewriting an
  attribution, not reproducing one, and this repository is English-only. The MIT notice remains
  verbatim at its own path, which is what MIT actually requires of a distribution.
- **Researching the four fonts.** Recommended for replacement rather than provenance archaeology,
  because for two of them the provenance is not recoverable at all.
- **68 of 91 Maven coordinates and 8 of 10 container images.** Recorded in `NOTICE` as _not yet
  verified_, not as permissive. Saying "these are the usual Apache Commons and Jackson artefacts, so
  they're fine" is exactly the reasoning that put an unlicensed proprietary charting library on the
  trading terminal.

## Brand-scan

`docs/LICENCE-POSITION.md` is allowlisted in `tooling/ci/brand-scan.mjs`, with the reason recorded
there. A licence-position document that cannot name the directory the unlicensed library sits in is
not actionable — the whole value of it is that an engineer can act on it without first asking which
path was meant. The root `NOTICE` has no file extension and so falls outside the scan's
`EXTENSIONS` set; it is allowlisted anyway, so that a future change to that set does not silently
break CI on a file whose entire purpose is to name upstreams accurately.

Both entries follow the same rationale already established for `docs/TERMINAL_INTEGRATION.md` and
`docs/adr/`: internal records must be free to name upstream vendors so that licensing and quarantine
scope stay auditable. Neither file is shipped to users.
