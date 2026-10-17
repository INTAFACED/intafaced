# packages/telemetry — promise audit 2026-08-08

Tip: `ea6e202a`

The question this audit was pointed at: **does anything silently swallow an
error or drop a span on a money path?** A logger that eats a failure is how a
Tier-1 defect returns invisibly.

The answer is yes — but not in the shape expected. There are no empty catch
blocks, no `.catch(() => undefined)`, and no built-then-discarded spans in this
package. The swallow was one level down, in the channel the module names.

## Promises checked (6)

| Promise                                                 | Verdict             |
| ------------------------------------------------------- | ------------------- |
| Telemetry never takes down a money service              | VERIFIED            |
| Export failures are "reported through the diag channel" | **BROKEN** → #1081  |
| The module "DOES insist on" flushing on shutdown        | **BROKEN** → parked |
| Disabling telemetry changes nothing but telemetry       | VERIFIED            |
| A double shutdown is safe                               | VERIFIED            |
| The OTLP URL is built correctly from a base endpoint    | VERIFIED            |

## Broken, fixed here

**The failure channel was switched off in all eighteen services.** `diag` is a
proxy: with no logger registered, every call is a silent no-op. `setLogger` ran
only under `options.debug`, and **no service passes it** — checked with a
positive control, `startTelemetry({` appears in all eighteen entrypoints and
`debug` in zero.

So on every deployment a down collector, a DNS failure and a full export queue
were all invisible — including this module's own
`diag.warn('telemetry shutdown failed')`, which called a channel that could not
carry it.

It is the same failure this package exists to end, one layer out. The test file
opens with it: eighteen services wrote spans into a no-op tracer and every one
looked healthy. The provider is real now, and a broken **export** was still
exactly as undetectable as the no-op tracer had been. → **PR #1081**

**A seam came with the fix, and it is not decoration.** `DiagConsoleLogger`
saves the original `console` methods at module load, deliberately, per its own
source comment: _"before any instrumentation can wrap them."_ So no spy and no
stream capture can ever observe its output — both were tried, the probe printed
and the capture stayed empty. `options.diagLogger` is what makes the promise
checkable at all.

**That the channel was both false and untestable is not a coincidence.** An
unobservable guarantee is one nobody notices breaking.

## Broken, parked — and why

**The one thing the module "DOES insist on" is not awaited by anything.**

> The one thing this module DOES insist on is flushing on shutdown: a batch
> processor holds spans in memory, so a service that exits without flushing
> loses its final batch — including, on a bad day, the last ledger post before
> the crash you are trying to explain.

`registerProcessHooks` fires `void handle.shutdown()` — fire and forget. All
eighteen services register their **own** SIGTERM/SIGINT handler, and it ends in
`process.exit(0)`, which aborts any in-flight OTLP POST. So the flush completes
only if it wins a race against the service's own teardown, and nothing enforces
the ordering. The exposure is the final seconds before shutdown, which is
exactly the window the docstring says matters.

**Parked:** fixing it properly means the telemetry shutdown is awaited _inside_
each service's teardown sequence rather than registered as a competing
listener — which changes eighteen entrypoints and arguably means
`registerProcessHooks` should not exist and `handle.shutdown()` should simply be
awaited in the existing sequence. That is a shape change to this package's
public API and deserves one decision, not eighteen patches.

Confidence: mechanism high (read across `start.ts` and all eighteen
entrypoints). **How often the race is actually lost: unverified** — it depends
on teardown duration versus collector round-trip, and the OTel SDK packages are
not installed in this checkout, so it could not be executed.

## Executed by nothing

- **`registerProcessHooks` has no test.** The flush-on-signal path is the
  module's stated reason for existing beyond registering a provider, and it is
  exercised by nothing. The test file's own header argues that a test which can
  pass while Tempo stays empty is the wrong test; that argument applies here
  with full force.
- **`isTelemetryActive` is called by nothing but its own test.** One caveat if
  it is ever wired to a health check: it reads `probe.isRecording()`, which a
  non-`AlwaysOn` head sampler would flip to `false` on a perfectly healthy
  service. `OTEL_TRACES_SAMPLER` appears nowhere in the repo, so the concern is
  dormant today.

## Anti-vacuity — a positive result

The `startTelemetry` test is **not** vacuous, and is unusually well built for
this: it stands up a real HTTP server, asserts the request count is non-zero,
finds the request whose path ends `/v1/traces`, and greps the actual payload
bytes for `ledger.post`, `intafaced.money_path` and `svc-ledger`. It proves the
pipeline end to end, and it is honest about its limit — it sets `money_path`
itself, so it proves transport, not that services tag correctly.

## Could NOT break, having tried

**Empty catches and discarded spans** — read every line of `start.ts`. One
catch, and it logs. `isTelemetryActive` deliberately never ends its probe span;
the reasoning checks out, because a span is only queued on `end()`, and it uses
`startSpan` rather than `startActiveSpan` so it does not leak into the context
either. The money-span helper it feeds sets ERROR status, records the exception,
and **re-throws** — clean.

**"Disabled telemetry changes behaviour"** — under `OTEL_ENABLED=false`,
`startTelemetry` returns a frozen no-op, `registerProcessHooks` returns before
installing a signal listener, and `shutdown()` resolves to nothing. Nothing else
in the repo branches on telemetry state. Disabling telemetry changes nothing but
telemetry.

**`registerProcessHooks` stealing process termination** — in Node, adding a
SIGTERM listener overrides the default terminate behaviour, so a service that
registered only this hook would hang on `docker stop` until SIGKILL. Checked all
eighteen: every one has its own handler and the four read in full call
`process.exit`. **Not a live bug** — worth one line in the docstring, because it
is true of any future caller that forgets.

**URL construction** — trailing slashes are stripped before the signal path is
appended, so a base ending in `/` or `///` produces one correct path.

**Double shutdown** — guarded by a flag, and tested.
