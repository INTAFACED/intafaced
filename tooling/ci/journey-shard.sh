#!/usr/bin/env bash
# The one setup of a Real-app journeys stack, after the runner is ready (.github/actions/journey-runner): the custody
# switch, the stack, the TEST markets, gates, chart history and content, the first trade, then the journeys. A Real-app
# journeys shard (.github/workflows/real-app-journeys.yml) runs it, and so does every probe, control and settle run of
# the journeys revert (main-bisect.yml, through tooling/ci/journeys-revert-probe.sh), so a red that depends on how main's
# run sets up its stack reproduces there too. (Failure it prevents, project-state#4151: the bisect kept its own copy of
# this setup without the shard's custody switch, so on 27 Nov 2026 J-p2p-21 and J-wallet-01, red on main from #11129,
# passed every probe: "No culprit … nothing reproduces", run 46009737757, and were filed as flaky.)
# tooling/ci/journey-shard.test.mjs fails a shard step or a probe that runs a stack command of its own.
#
# Runs from the checkout's root, with LOCAL_STACK_STATE (and the runner's other paths) set. The probe runs the copy from
# main-bisect's own commit on an older checkout, so a subcommand works with what that checkout has.
#
#   journey-shard.sh custody "<journey files>"   prints the switch launch-custody.mjs gives those files (on or off)
#   journey-shard.sh start                       starts the stack (LOCAL_STACK_CUSTODY_LAYER, as `custody` printed)
#   journey-shard.sh markets                     opens the TEST markets; history unless the shard's files read no past
#   journey-shard.sh content                     loads the TEST content
#   journey-shard.sh maker                       starts the TEST market maker (on a seeded stack)
#   journey-shard.sh first-trade                 waits for the TEST market maker's first BTC/USDT trade
#   journey-shard.sh journeys [playwright args]  runs JOURNEY_FILES (or the args' split) in the running app
set -euo pipefail

custody_now() { node tooling/scripts/local-test-stack.mjs custody; }

case "${1:-}" in
  custody)
    # A checkout from before the switch (#11077) ran every journey on the stack's default, on.
    if [ ! -f tooling/scripts/launch-custody.mjs ]; then
      echo on
      exit 0
    fi
    node tooling/scripts/launch-custody.mjs --files "${2:?journey files}"
    ;;

  start)
    df -h /
    node tooling/scripts/local-test-stack.mjs start
    ;;

  # A fresh stack trades only after the TEST gates open the markets and verify the market maker's two TEST accounts
  # (docs/LOCAL-TEST-STACK.md, "A fresh stack"). Matching reads its operator seats when it starts, so it restarts
  # after the founders enrolled. The market maker refuses to start on closed markets and creates its accounts when it
  # starts, so `verify` runs after it. It stops again before `verify`, so no market trades before `history`: that
  # writes the TEST tape history the chart journeys read (real TEST trades whose times svc-trade moves into the past,
  # docs/LOCAL-TEST-STACK.md, "Chart history"), and it only writes on a market with no trades yet. It exits non-zero
  # when any market comes up short, and that fails the step on purpose: chart journeys on a partial history would
  # fail later for a reason the log no longer shows.
  # With the stack's custody switch off (the launch build's, OWNER 288), our own order book is off, so its TEST market
  # maker and its chart history are not started (local-test-market.mjs, CUSTODY_ON_ONLY): the gates still open and
  # verify, and launch journeys trade at the TEST venue.
  # The history goes only on the markets journeys read the past of (`--markets journeys`, HISTORY_SYMBOLS in
  # local-test-market.mjs, which local-test-market-history.test.mjs keeps whole): four of six markets, 149 s against 193 s
  # measured on one shard on 13 Nov, a saving every shard makes (project-state #2065 row d37).
  # A shard whose journey files provably read no market's past writes none (tooling/scripts/
  # journey-market-past.mjs: no chart, candle, tape or backtest word in the file or the helpers it imports): the
  # history was 208 s of this step's 297 on run 43668181917. Every planned shard asks (SHARDS and SHARD set), a full
  # run's (main's, a pull request's) as a targeted run's: 43 of a full plan's 90 shards read none (project-state#3329:
  # full runs held all 500 hosted runners). Any doubt writes it, and a run without a plan, a probe's included, always
  # does. A journey that reads the past without it sees an empty chart and fails; it never passes on one.
  markets)
    history=journeys
    if [ -n "${SHARDS:-}" ]; then
      history=$(node tooling/scripts/journey-market-past.mjs --shard "$SHARD") || history=journeys
    fi
    node tooling/scripts/local-test-stack.mjs restart matching
    node tooling/scripts/local-test-gates.mjs apply
    if [ "$(custody_now)" = off ]; then
      node tooling/scripts/local-test-market.mjs
      node tooling/scripts/local-test-gates.mjs verify
      exit 0
    fi
    node tooling/scripts/local-test-market.mjs
    # The market maker registers its accounts in the background; verify only once both exist.
    for _ in $(seq 1 30); do
      grep -Eq 'taker (created|existing) \(test_taker\)' "$LOCAL_STACK_STATE/logs/market.log" 2>/dev/null && break
      sleep 2
    done
    node tooling/scripts/local-test-market.mjs stop
    node tooling/scripts/local-test-gates.mjs verify
    if [ "$history" = none ]; then
      echo "::notice::no TEST chart history: this shard's journeys read no market's past (tooling/scripts/journey-market-past.mjs)"
    else
      node tooling/scripts/local-test-market.mjs history --markets journeys
    fi
    node tooling/scripts/local-test-market.mjs
    ;;

  # Labelled TEST rows (earn pools, loan products, a TEST P2P method) so those rooms show working, after the gates
  # published the limits they need (docs/LOCAL-TEST-STACK.md, "Local test content"). Production stays blank.
  content)
    LOCAL_TEST=1 node tooling/scripts/local-test-seed.mjs apply --state "$LOCAL_STACK_STATE"
    ;;

  # On the seeded stack the market maker was stopped before the copy, so it starts here, as the last line of `markets`
  # does on a stack the shard seeds itself.
  maker)
    if [ "$(custody_now)" = off ]; then
      echo "custody off: no TEST market maker on our own order book"
      exit 0
    fi
    node tooling/scripts/local-test-market.mjs
    ;;

  first-trade)
    if [ "$(custody_now)" = off ]; then
      echo "custody off: no TEST market maker on our own order book, so no trade to wait for"
      exit 0
    fi
    for _ in $(seq 1 60); do
      grep -q 'BTC/USDT crossing trade by test_taker: .* -> HTTP 201' "$LOCAL_STACK_STATE/logs/market.log" 2>/dev/null && exit 0
      sleep 5
    done
    echo "::error::no BTC/USDT trade from the TEST market maker within 5 minutes"
    tail -40 "$LOCAL_STACK_STATE/logs/market.log"
    exit 1
    ;;

  # No traces: they would carry the run's TEST session and password into a public artifact. Pictures stay: every test
  # that opens a page leaves one as it ends, passed or failed (the config's `screenshot: 'on'`, project-state d88).
  journeys)
    shift
    exec pnpm exec playwright test --config apps/customer/tests/real-app/real-app.playwright.config.mjs --trace off "$@"
    ;;

  *)
    echo "usage: journey-shard.sh custody|start|markets|content|maker|first-trade|journeys" >&2
    exit 2
    ;;
esac
