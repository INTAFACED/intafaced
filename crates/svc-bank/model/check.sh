#!/usr/bin/env bash
# Model-checks ReceivedHold.tla: the code as it is now must keep every rule, the code before #8586's fix must be shown
# breaking the promise, and each deliberately broken variant must fail on the rule it breaks. Exit 0 only when all of that holds. Needs Java 11+ (`java` on PATH, or $JAVA).
# The TLA+ tools are pinned to v1.7.4 by URL and SHA-256 and cached in ${TLA_CACHE:-~/.cache/intafaced-tla}.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TLA_VERSION=v1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
cache="${TLA_CACHE:-$HOME/.cache/intafaced-tla}/$TLA_VERSION"
jar="$cache/tla2tools.jar"
java="${JAVA:-java}"

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

mkdir -p "$cache"
if [ ! -f "$jar" ] || [ "$(sha256 "$jar")" != "$TLA_SHA256" ]; then
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar" ||
    { echo "COULD NOT CHECK: tla2tools.jar $TLA_VERSION did not download" >&2; exit 3; }
  got="$(sha256 "$jar.part")"
  if [ "$got" != "$TLA_SHA256" ]; then echo "tla2tools.jar $TLA_VERSION has sha256 $got, expected $TLA_SHA256; COULD NOT CHECK" >&2; exit 3; fi
  mv "$jar.part" "$jar"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0
couldnt=0
ALL="NeverStranded HeldHasHold HoldOnce OneOutcome OutcomeMatches"

# The whole counterexample of a run that broke a rule, from the line that names the break to the end; a run that
# names none prints its last 80 lines.
trace() {
  if grep -qE 'is violated|Deadlock reached' "$1"; then sed -nE '/is violated|Deadlock reached/,$p' "$1"; else tail -n 80 "$1"; fi
}

# run <name> <placers> <invariants> <expect: "pass" or the invariant that must be violated> [<sed expression>]
run() {
  local name="$1" placers="$2" invariants="$3" expect="$4" breaks="${5:-}" d="$work/$1"
  mkdir -p "$d"
  if [ -n "$breaks" ]; then
    sed -E "$breaks" "$here/ReceivedHold.tla" > "$d/ReceivedHold.tla"
    if cmp -s "$here/ReceivedHold.tla" "$d/ReceivedHold.tla"; then echo "FAIL $name: the variant did not change the model"; failed=1; return; fi
  else
    cp "$here/ReceivedHold.tla" "$d/ReceivedHold.tla"
  fi
  printf 'CONSTANTS Placers = {%s}  B = 2  MaxT = %s  Tries = 2\nSPECIFICATION Spec\nINVARIANTS %s\n' \
    "$placers" "${MAXT:-8}" "$invariants" > "$d/ReceivedHold.cfg"
  local status=0
  ( cd "$d" && "$java" -XX:+UseSerialGC -Xmx2g -cp "$jar" tlc2.TLC -workers "${WORKERS:-auto}" -config ReceivedHold.cfg ReceivedHold.tla > out.txt 2>&1 ) || status=$?
  # TLC's exit: 0 no error, 11 to 13 a broken rule (deadlock, invariant, temporal property); anything else (a parse
  # error, out of memory, no Java) means it could not check, which is no verdict on the code (pstack statechart run.ts).
  case "$status" in 0 | 11 | 12 | 13) ;; *) echo "COULD NOT CHECK $name: TLC exit $status"; tail -n 40 "$d/out.txt"; couldnt=1; return ;; esac
  local states; states="$(grep -Eo '[0-9,]+ distinct states found' "$d/out.txt" | tail -1 || true)"
  if [ "$expect" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q 'No error has been found' "$d/out.txt"; then echo "ok   $name: no error, $states"
    else echo "FAIL $name: expected no error (exit $status)"; trace "$d/out.txt"; failed=1; fi
  else
    if grep -q "Invariant $expect is violated" "$d/out.txt"; then echo "ok   $name: $expect violated as it should be, $states"
      if [ -n "${SHOW_TRACE:-}" ]; then sed -n "/is violated/,\$p" "$d/out.txt"; fi
    else echo "FAIL $name: expected $expect to be violated (exit $status)"; grep -E 'violated|No error|Error' "$d/out.txt" | head -5; failed=1; fi
  fi
}

# The code as it is now keeps every rule, with the timer alone and with both placers.
run code-one-placer  '"sweep"' "$ALL" pass
run code-two-placers '"inline", "sweep"' "$ALL" pass
# ...and does reach a row lapsed while its hold was on its way, which the timer then puts back: the promise is not empty.
run code-reaches-the-window '"inline", "sweep"' LapsedNeverHoldsMoney LapsedNeverHoldsMoney
# The code before #8586's fix (the three `fix:` lines taken out): a hold lands after its row lapsed and stays there.
BEFORE='s/IF state # "placing" \/\\ TRUE( +\\\* fix: claim)/IF FALSE\1/; s/\{"placing", "lapsed"\}( +\\\* fix: un-lapse)/{"placing"}\1/; s/\/\\ holdKey \/\\ TRUE( +\\\* fix: heal)/\/\\ FALSE\1/'
run before-fix '"inline", "sweep"' NeverStranded NeverStranded "$BEFORE"

# Broken on purpose, each failing on the rule it exists for.
# 1. Without the claim: a placer that read the row before it lapsed posts long after, past the timer's window.
run broken-no-claim '"inline", "sweep"' "$ALL" NeverStranded 's/IF state # "placing" \/\\ TRUE( +\\\* fix: claim)/IF FALSE\1/'
# 2. The timer's window is only the in-flight bound: a hold landing at its end is looked at once the window has closed.
run broken-window-one-bound '"inline", "sweep"' "$ALL" NeverStranded 's/^Window == 2 \* B$/Window == B/'
# 3. The timer puts a lapsed row back to held without asking the ledger for its hold.
run broken-heal-without-hold '"inline", "sweep"' "$ALL" HeldHasHold 's/\/\\ holdKey \/\\ TRUE( +\\\* fix: heal)/\/\\ TRUE\1/'
# 4. The hold key is not idempotent: a repeated request books the hold again.
run broken-hold-key-repeats '"inline", "sweep"' "$ALL" HoldOnce 's/IF holdKey THEN \/\\ UNCHANGED/IF FALSE THEN \/\\ UNCHANGED/; s/IF bal >= 1 THEN \/\\ bal. = bal - 1 \/\\ pot. = 1/IF bal >= 1 THEN \/\\ bal\x27 = bal - 1 \/\\ pot\x27 = pot + 1/'
# 5. A claim that does not check the row is still held: Deny after Accept flips a released payment to returning.
run broken-claim-without-cas '"sweep"' "$ALL" OutcomeMatches 's/state = "held"$/state \\notin {"placing", "lapsed"}/'

# The CashOutLock model (#8597) shares this folder; CI runs one check.sh per folder, so it runs from here.
cash=0
"$here/check-cashout.sh" || cash=$?
case "$cash" in 0) ;; 3) couldnt=1 ;; *) failed=1 ;; esac

# A broken rule fails (1); a run that could not check, with no rule broken, exits 3: the workflow reads it as judge down.
if [ "$failed" -eq 0 ] && [ "$couldnt" -eq 1 ]; then exit 3; fi
exit "$failed"
