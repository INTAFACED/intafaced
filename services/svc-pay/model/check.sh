#!/usr/bin/env bash
# Model-checks PayoutQuery.tla: with the lock held the code keeps every rule; with the lock lost the promise breaks
# (the finding, until a fix lands); the proposed fix keeps every rule; each deliberately broken variant fails on the
# rule it breaks. Exit 0 only when all of that holds. Needs Java 11+ (`java` on PATH, or $JAVA).
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
ALL="NeverPaidTwice ReversedOnce SignedOnce"

# The whole counterexample of a run that broke a rule, from the line that names the break to the end; a run that
# names none prints its last 80 lines.
trace() {
  if grep -qE 'is violated|Deadlock reached' "$1"; then sed -nE '/is violated|Deadlock reached/,$p' "$1"; else tail -n 80 "$1"; fi
}

# run <name> <canLose> <fixed> <invariants> <expect: "pass", "deadlock" or the invariant that must be violated> [<sed expression>]
# TLC's deadlock check is on unless DEADLOCK=FALSE: a state with no step out other than `Done` fails.
run() {
  local name="$1" lose="$2" fixed="$3" invariants="$4" expect="$5" breaks="${6:-}" d="$work/$1"
  mkdir -p "$d"
  if [ -n "$breaks" ]; then
    sed -E "$breaks" "$here/PayoutQuery.tla" > "$d/PayoutQuery.tla"
    if cmp -s "$here/PayoutQuery.tla" "$d/PayoutQuery.tla"; then echo "FAIL $name: the variant did not change the model"; failed=1; return; fi
  else
    cp "$here/PayoutQuery.tla" "$d/PayoutQuery.tla"
  fi
  printf 'CONSTANTS CanLose = %s  Fixed = %s  TakesPending = %s\nSPECIFICATION Spec\nINVARIANTS %s\nCHECK_DEADLOCK %s\n' "$lose" "$fixed" "${TAKES:-TRUE}" "$invariants" "${DEADLOCK:-TRUE}" > "$d/PayoutQuery.cfg"
  local status=0
  ( cd "$d" && "$java" -XX:+UseSerialGC -Xmx1g -cp "$jar" tlc2.TLC -workers 1 -config PayoutQuery.cfg PayoutQuery.tla > out.txt 2>&1 ) || status=$?
  # TLC's exit: 0 no error, 11 to 13 a broken rule (deadlock, invariant, temporal property); anything else (a parse
  # error, out of memory, no Java) means it could not check, which is no verdict on the code (pstack statechart run.ts).
  case "$status" in 0 | 11 | 12 | 13) ;; *) echo "COULD NOT CHECK $name: TLC exit $status"; tail -n 40 "$d/out.txt"; couldnt=1; return ;; esac
  local states; states="$(grep -Eo '[0-9,]+ distinct states found' "$d/out.txt" | tail -1 || true)"
  if [ "$expect" = deadlock ]; then
    if grep -q 'Deadlock reached' "$d/out.txt"; then echo "ok   $name: deadlock reached, the dead end of #8828 before its fix, $states"
      if [ -n "${SHOW_TRACE:-}" ]; then sed -n "/Deadlock reached/,\$p" "$d/out.txt"; fi
    else echo "FAIL $name: expected the dead end of #8828 before its fix (exit $status)"; grep -E 'violated|No error|Error' "$d/out.txt" | head -5; failed=1; fi
  elif [ "$expect" = pass ]; then
    if [ "$status" -eq 0 ] && grep -q 'No error has been found' "$d/out.txt"; then echo "ok   $name: no error, $states"
    else echo "FAIL $name: expected no error (exit $status)"; trace "$d/out.txt"; failed=1; fi
  else
    if grep -q "Invariant $expect is violated" "$d/out.txt"; then echo "ok   $name: $expect violated as it should be, $states"
      if [ -n "${SHOW_TRACE:-}" ]; then sed -n "/is violated/,\$p" "$d/out.txt"; fi
    else echo "FAIL $name: expected $expect to be violated (exit $status)"; grep -E 'violated|No error|Error' "$d/out.txt" | head -5; failed=1; fi
  fi
}

# The code: not_sent closes the key (#8604) and takes a claim with no signed bytes (#8828). Every rule holds, the lock held
# or lost, the payer dying and retrying included, and no state is left with the hold stuck (the deadlock check is on).
run code-lock-held FALSE TRUE "$ALL" pass
run code-lock-lost TRUE TRUE "$ALL" pass
# Before #8828 (a query answered unknown for any claimed key): a send that claimed its key and died or whose signer threw
# before journalling signed bytes left the payout with no step out: every retry's claim stalls, every query answers
# unknown, the hold stays.
TAKES=FALSE run before-8828-ends FALSE TRUE "$ALL" deadlock
# Before #8604 (not_sent left the key open) the rules held only with the lock held: with the lock's connection dropped during
# the rail call, a reconciler heard not_sent while the payer was signing, gave the money back, and the payer's send then left.
run open-lock-held      FALSE FALSE "$ALL" pass
run open-lock-lost      TRUE FALSE NeverPaidTwice NeverPaidTwice
run open-lock-lost-kept TRUE FALSE "ReversedOnce SignedOnce" pass

# Broken on purpose, each failing on the rule it exists for.
# 1. lookupSend ignores the journalled signed bytes: a payer that died after its broadcast, before journalling the hash,
#    is reversed although its transaction left.
run broken-no-signed-check FALSE FALSE "$ALL" NeverPaidTwice 's/ELSE IF signed THEN "unknown"/ELSE IF FALSE THEN "unknown"/'
# 2. The reverse is not keyed: a second reconcile pass gives the money back again.
run broken-reverse-unkeyed FALSE FALSE "$ALL" ReversedOnce 's/IF Answer = "not_sent" \/\\ ~failed/IF Answer = "not_sent"/; s/reversals. = \(IF reversals = 0 THEN 1 ELSE reversals\)/reversals\x27 = reversals + 1/; s/rpc. = "done" \/\\ Free/rpc\x27 = "idle" \/\\ Free/; s/^RLock == \/\\ rpc = "idle" \/\\ lock = NULL \/\\ dispatched \/\\ ~failed/RLock == \/\\ rpc = "idle" \/\\ lock = NULL \/\\ dispatched \/\\ reversals < 2/'
# 3. A retry that finds a pending claim signs again instead of stalling: a second, different transaction is signed.
run broken-resign-on-pending FALSE FALSE "$ALL" SignedOnce 's/ELSE \(ppc. = "end" \/\\ UNCHANGED claimed\)( +)\\\* claim stalled/ELSE (ppc\x27 = "sign" \/\\ UNCHANGED claimed)\1\\* claim stalled/'
# 4. putSigned does not need the pending claim: a query takes the claim of a send still signing, gives the money back,
#    and the send journals its bytes and broadcasts anyway (the lock lost, so the query comes while the send signs).
run broken-putsigned-ignores-close TRUE TRUE "$ALL" NeverPaidTwice 's/IF closed THEN \(ppc. = "end" \/\\ UNCHANGED signed\) ELSE/IF FALSE THEN (ppc\x27 = "end" \/\\ UNCHANGED signed) ELSE/'

# A broken rule fails (1); a run that could not check, with no rule broken, exits 3: the workflow reads it as judge down.
if [ "$failed" -eq 0 ] && [ "$couldnt" -eq 1 ]; then exit 3; fi
exit "$failed"
