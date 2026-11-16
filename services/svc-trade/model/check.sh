#!/usr/bin/env bash
# Model-checks OneHold.tla: the code as it is must pass every rule, and each deliberately broken variant must
# fail on the rule it breaks. Exit 0 only when all of that holds. Needs Java 11+ (`java` on PATH, or $JAVA).
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

# run <name> <closers> <expect: "pass" or the invariant that must be violated> [<sed expression that breaks the model>]
run() {
  local name="$1" paths="$2" expect="$3" breaks="${4:-}" d="$work/$1"
  mkdir -p "$d"
  if [ -n "$breaks" ]; then
    sed -E "$breaks" "$here/OneHold.tla" > "$d/OneHold.tla"
    if cmp -s "$here/OneHold.tla" "$d/OneHold.tla"; then echo "FAIL $name: the variant did not change the model"; failed=1; return; fi
  else
    cp "$here/OneHold.tla" "$d/OneHold.tla"
  fi
  printf 'CONSTANTS H = 2  Q = 1  R = 2  Paths = {%s}\nSPECIFICATION Spec\nINVARIANTS Conservation PaysOnce NoReleaseOfOwed EveryFillPaid\nCHECK_DEADLOCK FALSE\n' "$paths" > "$d/OneHold.cfg"
  local status=0
  ( cd "$d" && "$java" -XX:+UseSerialGC -Xmx512m -cp "$jar" tlc2.TLC -workers 1 -config OneHold.cfg OneHold.tla > out.txt 2>&1 ) || status=$?
  local states; states="$(grep -Eo '[0-9,]+ distinct states found' "$d/out.txt" | head -1 || true)"
  if [ "$expect" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q 'No error has been found' "$d/out.txt"; then echo "ok   $name: no error, $states"
    else echo "FAIL $name: expected no error (exit $status)"; sed -n '1,60p' "$d/out.txt"; failed=1; fi
  else
    if grep -q "Invariant $expect is violated" "$d/out.txt"; then echo "ok   $name: $expect violated as it should be, $states"
    else echo "FAIL $name: expected $expect to be violated (exit $status)"; grep -E 'violated|No error|Error' "$d/out.txt" | head -5; failed=1; fi
  fi
}

# The code as it is: every closer hands finalize the engine's remainder, and finalize refuses under the row lock.
run code-cancel-mass-stp '"user", "mass", "stp"' pass
run code-expiry-sweep    '"user", "expiry", "sweep"' pass

# Broken on purpose, each a real past mistake or the one its rule exists for.
# 1. #8560 itself: "cancel all" finalizes without the engine's remainder (svc-trade before this check moved into finalize).
run broken-mass-skips-guard '"user", "mass"' NoReleaseOfOwed 's/^Evidenced == Closers \\cup \{"CC"\}/Evidenced == (Closers \\ {"mass"}) \\cup {"CC"}/'
# 2. The fill posts without its trade.fill:<id> key, so a redelivered fill pays twice.
run broken-no-fill-key '"user"' PaysOnce 's/IF fillPosts > 0 THEN/IF FALSE THEN/'
# 3. The release ignores the fill rows already written (hold - 0 instead of hold - sum of fills).
run broken-sum-ignores-rows '"user"' NoReleaseOfOwed 's/sumRead EXCEPT !\[p\] = IF rows THEN Q ELSE 0\]/sumRead EXCEPT ![p] = 0]/'

exit "$failed"
