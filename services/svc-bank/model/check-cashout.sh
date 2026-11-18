#!/usr/bin/env bash
# Model-checks CashOutLock.tla: the code (with its fix for #8597) keeps every rule, the lock held or lost; the code
# before the fix breaks the promise with the lock lost; each deliberately broken variant fails on the rule it breaks. TLC's deadlock check is on: a state with no step out
# other than `Done` (every driver finished) fails. Exit 0 only when all of that holds. Needs Java 11+ (`java` on PATH, or $JAVA).
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
  curl -fsSL -o "$jar.part" "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar"
  got="$(sha256 "$jar.part")"
  if [ "$got" != "$TLA_SHA256" ]; then echo "tla2tools.jar $TLA_VERSION has sha256 $got, expected $TLA_SHA256" >&2; exit 2; fi
  mv "$jar.part" "$jar"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failed=0
ALL="RefusedTookNothing TakenMeansMoved TakenStays MovedOnce"
KEPT="TakenMeansMoved TakenStays MovedOnce"

# run <name> <canLose> <fixed> <invariants> <expect: "pass" or the invariant that must be violated> [<sed expression>]
run() {
  local name="$1" lose="$2" fixed="$3" invariants="$4" expect="$5" breaks="${6:-}" d="$work/$1"
  mkdir -p "$d"
  if [ -n "$breaks" ]; then
    sed -E "$breaks" "$here/CashOutLock.tla" > "$d/CashOutLock.tla"
    if cmp -s "$here/CashOutLock.tla" "$d/CashOutLock.tla"; then echo "FAIL $name: the variant did not change the model"; failed=1; return; fi
  else
    cp "$here/CashOutLock.tla" "$d/CashOutLock.tla"
  fi
  printf 'CONSTANTS Procs = {"call", "redrive"}  CanLose = %s  Fixed = %s\nSPECIFICATION Spec\nINVARIANTS %s\n' \
    "$lose" "$fixed" "$invariants" > "$d/CashOutLock.cfg"
  local status=0
  ( cd "$d" && "$java" -XX:+UseSerialGC -Xmx1g -cp "$jar" tlc2.TLC -workers 1 -config CashOutLock.cfg CashOutLock.tla > out.txt 2>&1 ) || status=$?
  local states; states="$(grep -Eo '[0-9,]+ distinct states found' "$d/out.txt" | tail -1 || true)"
  if [ "$expect" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q 'No error has been found' "$d/out.txt"; then echo "ok   $name: no error, $states"
    else echo "FAIL $name: expected no error (exit $status)"; sed -n '1,80p' "$d/out.txt"; failed=1; fi
  else
    if grep -q "Invariant $expect is violated" "$d/out.txt"; then echo "ok   $name: $expect violated as it should be, $states"
      if [ -n "${SHOW_TRACE:-}" ]; then sed -n "/is violated/,\$p" "$d/out.txt"; fi
    else echo "FAIL $name: expected $expect to be violated (exit $status)"; grep -E 'violated|No error|Error' "$d/out.txt" | head -5; failed=1; fi
  fi
}

# The code (Fixed, #8597): with the lock held or lost, it keeps every rule.
run code-lock-held FALSE TRUE "$ALL" pass
run code-lock-lost TRUE TRUE "$ALL" pass
# The code before the fix: with the lock's connection dropped mid-body, a refused request is left with its money taken.
run unfixed-lock-lost      TRUE FALSE RefusedTookNothing RefusedTookNothing
run unfixed-lock-lost-kept TRUE FALSE "$KEPT" pass

# Broken on purpose, each failing on the rule it exists for, with the lock held.
# 1. The row is not read again under the lock: a driver that read it before the other refused it moves anyway.
run broken-no-reread FALSE FALSE "$ALL" RefusedTookNothing 's/IF status = "processing" THEN Go\(p, "move"\)/IF TRUE THEN Go(p, "move")/'
# 2. The partner does not deduplicate on the key: a second move is made.
run broken-key-repeats TRUE FALSE "$KEPT" MovedOnce 's/IF moves > 0 THEN/IF FALSE THEN/'
# 3. The refusal is recorded without `WHERE status = 'processing'`: a taken request is turned refused.
run broken-refuse-without-check TRUE FALSE "$KEPT" TakenStays 's/^  \/\\ IF status = "processing"$/  \/\\ IF status = "processing" \\\/ answer[p] = "refused"/'

exit "$failed"
