#!/usr/bin/env bash
# Waits until every container of a compose project is healthy, or says which is not.
#
#   tooling/infra/compose-health.sh <tries> <compose args...>     e.g. 60 -f docker-compose.apps.yml
#
# Exit 0: every container runs healthy (or has no health check), and every one-shot job exited 0.
# Exit 1: a container is in a terminal bad state (exited non-zero, dead, unhealthy, or restarted three times), or the
# fleet was still starting after <tries> checks ten seconds apart. Prints one line per container either way; never a
# container's logs, which can echo its settings into a public Actions log.
# The same reading as staging-deploy.yml's "Every container is healthy", runnable on the machine the stack is on.
set -euo pipefail
tries="$1"
shift

report() {
  for id in $(docker compose "$@" ps -aq); do
    docker inspect "$id" --format \
      '{{.Name}} restarts={{.RestartCount}} status={{.State.Status}} exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
  done
}

for _ in $(seq 1 "$tries"); do
  pending=0
  broken=''
  while read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *' status=running '*' health=healthy') ;;
      *' status=running '*' health=none') ;;
      *' status=exited exit=0 '*) ;;
      *' restarts='[3-9]' '*|*' restarts='[1-9][0-9]*) broken="${broken}${line}"$'\n' ;;
      *' health=starting') pending=1 ;;
      *' status=created '*|*' status=restarting '*) pending=1 ;;
      *) broken="${broken}${line}"$'\n' ;;
    esac
  done <<< "$(report "$@")"

  if [ -z "$broken" ] && [ "$pending" -eq 0 ]; then
    echo "every container is healthy"
    report "$@"
    exit 0
  fi
  if [ -n "$broken" ]; then
    echo "containers in a terminal bad state:"
    printf '%s' "$broken"
    echo "all containers:"
    report "$@"
    exit 1
  fi
  sleep 10
done

echo "the stack was still starting after $tries checks"
report "$@"
exit 1
