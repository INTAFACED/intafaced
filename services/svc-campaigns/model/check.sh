#!/usr/bin/env bash
# Model-checks RewardPay.tla: the code as it is now must keep every rule, the code before #8581's fix must be shown
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
KEPT="OneSendPerReward PaidOnAMinedTransfer OneTransferOneReward BookedOnAMinedTransfer BookedOnce"

# The whole counterexample of a run that broke a rule, from the line that names the break to the end; a run that
# names none prints its last 80 lines.
trace() {
  if grep -qE 'is violated|Deadlock reached' "$1"; then sed -nE '/is violated|Deadlock reached/,$p' "$1"; else tail -n 80 "$1"; fi
}

# run <name> <procs> <invariants> <expect: "pass" or the invariant that must be violated> [<sed expression>]
run() {
  local name="$1" procs="$2" invariants="$3" expect="$4" breaks="${5:-}" d="$work/$1"
  mkdir -p "$d"
  if [ -n "$breaks" ]; then
    sed -E "$breaks" "$here/RewardPay.tla" > "$d/RewardPay.tla"
    if cmp -s "$here/RewardPay.tla" "$d/RewardPay.tla"; then echo "FAIL $name: the variant did not change the model"; failed=1; return; fi
  else
    cp "$here/RewardPay.tla" "$d/RewardPay.tla"
  fi
  printf 'CONSTANTS Procs = {%s}  Rewards = {"a", "b"}\nSPECIFICATION Spec\nCONSTRAINT Bound\nINVARIANTS %s\nCHECK_DEADLOCK FALSE\n' \
    "$procs" "$invariants" > "$d/RewardPay.cfg"
  local status=0
  ( cd "$d" && "$java" -XX:+UseSerialGC -Xmx512m -cp "$jar" tlc2.TLC -workers 1 -config RewardPay.cfg RewardPay.tla > out.txt 2>&1 ) || status=$?
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

ALL="NeverGiveUpOnALiveSend $KEPT"
# The code as it is now keeps every rule, the promise included, with one payer and with two (replicas).
run code-one-payer  '"p1"'       "$ALL" pass
run code-two-payers '"p1", "p2"' "$ALL" pass
# The code before #8581's fix gave a payment up while its transfer could still land: the finding.
run before-fix '"p1"' NeverGiveUpOnALiveSend NeverGiveUpOnALiveSend 's/IF late\[r\] \/\\ FALSE THEN FailCAS/IF late[r] THEN FailCAS/'

# Broken on purpose, each failing on the rule it exists for.
# 1. No payment row before the send (no ON CONFLICT (reward_key)): a second pass sends the same reward again.
run broken-no-row-before-send '"p1"' "$ALL" OneSendPerReward 's/intent\[r\] = "owed" \/\\ pay\[r\] = "none"/intent[r] = "owed" \/\\ pay[r] \\in {"none", "sending"}/'
# 2. find() takes a hash another reward already holds (no claimed set, no UNIQUE chain_tx): one transfer pays two.
run broken-no-claimed-set '"p1"' "$ALL" OneTransferOneReward 's/IF \\E x \\in Rewards : txOf\[x\] = h$/IF FALSE/; s/chain\[h\]\.s = "mined" \/\\ h \\notin claimed/chain[h].s = "mined"/'
# 3. A reverted receipt read as success: a payment is booked on a transfer that never moved the money.
run broken-revert-as-paid '"p1"' "$ALL" BookedOnAMinedTransfer 's/\[\] chain\[h\]\.s = "reverted"( +)-> \/\\ FailCAS\(r\) \/\\ Idle\(p\)/[] FALSE\1-> UNCHANGED pay/; s/\[\] chain\[h\]\.s = "mined"( +)->/[] chain[h].s \\in {"mined", "reverted"} ->/'

# A broken rule fails (1); a run that could not check, with no rule broken, exits 3: the workflow reads it as judge down.
if [ "$failed" -eq 0 ] && [ "$couldnt" -eq 1 ]; then exit 3; fi
exit "$failed"
