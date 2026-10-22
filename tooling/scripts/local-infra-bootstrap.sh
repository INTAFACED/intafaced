#!/usr/bin/env bash
# local-infra-bootstrap — one-shot host setup so `pnpm verify` can be a real seal,
# not an INCOMPLETE laptop run.
#
# WHY THIS EXISTS
#   Agents were legislated to "verify green before push" while this Mac had no
#   Docker daemon. That trains stall or lie. Tool before law.
#
# WHAT IT INSTALLS / STARTS
#   · Foundry (forge/anvil/cast) under .tools/foundry  (in-repo, no brew)
#   · Colima + Lima + Docker CLI under .tools/vendor-bin (in-repo binaries)
#   · Starts Colima VM with project-local COLIMA_HOME / LIMA_HOME
#
# RUN THIS ONCE in Terminal.app / iTerm (not a sandboxed agent), from repo root:
#   bash tooling/scripts/local-infra-bootstrap.sh
#
# Needs: curl, macOS arm64 or x86_64, ability to run VZ/QEMU VMs.
# If brew can write /opt/homebrew/Cellar, also: brew install qemu (for qcow2 disks).
#
# After success:
#   export PATH="$PWD/.tools/foundry/bin:$PWD/.tools/vendor-bin/bin:$PATH"
#   export COLIMA_HOME="$PWD/.tools/colima-home"
#   export LIMA_HOME="$PWD/.tools/lima-home"
#   export DOCKER_HOST="unix://${COLIMA_HOME}/default/docker.sock"
#   docker run --rm hello-world
#   pnpm verify   # may still be incomplete if Postgres images not up — see infra-verdict
#
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) COLIMA_ASSET=Darwin-arm64; LIMA_ASSET=Darwin-arm64; DOCKER_ARCH=aarch64 ;;
  x86_64|amd64)  COLIMA_ASSET=Darwin-x86_64; LIMA_ASSET=Darwin-x86_64; DOCKER_ARCH=x86_64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

TOOLS="$ROOT/.tools"
FOUNDRY_DIR="$TOOLS/foundry"
VENDOR="$TOOLS/vendor-bin"
COLIMA_HOME="$TOOLS/colima-home"
LIMA_HOME="$TOOLS/lima-home"
mkdir -p "$FOUNDRY_DIR/bin" "$VENDOR/bin" "$COLIMA_HOME" "$LIMA_HOME"

export FOUNDRY_DIR COLIMA_HOME LIMA_HOME
export PATH="$FOUNDRY_DIR/bin:$VENDOR/bin:$PATH"

echo "==> Foundry (foundryup → $FOUNDRY_DIR)"
if [[ ! -x "$FOUNDRY_DIR/bin/foundryup" ]]; then
  curl -sL https://foundry.paradigm.xyz -o /tmp/foundry-install.sh
  # Install into FOUNDRY_DIR without touching ~/.foundry when possible
  FOUNDRY_DIR="$FOUNDRY_DIR" bash /tmp/foundry-install.sh || true
fi
if [[ -x "$FOUNDRY_DIR/bin/foundryup" ]]; then
  FOUNDRY_DIR="$FOUNDRY_DIR" "$FOUNDRY_DIR/bin/foundryup"
else
  echo "warn: foundryup missing — download manually from https://book.getfoundry.sh"
fi

echo "==> Colima + Lima + Docker CLI → $VENDOR"
COLIMA_VER="${COLIMA_VER:-v0.10.3}"
LIMA_VER="${LIMA_VER:-1.0.7}"
DOCKER_VER="${DOCKER_VER:-27.5.1}"

if [[ ! -x "$VENDOR/bin/colima" ]]; then
  curl -sL "https://github.com/abiosoft/colima/releases/download/${COLIMA_VER}/colima-${COLIMA_ASSET}" -o "$VENDOR/bin/colima"
  chmod +x "$VENDOR/bin/colima"
fi
if [[ ! -x "$VENDOR/bin/limactl" ]]; then
  curl -sL "https://github.com/lima-vm/lima/releases/download/v${LIMA_VER}/lima-${LIMA_VER}-${LIMA_ASSET}.tar.gz" -o /tmp/lima.tgz
  tar -xzf /tmp/lima.tgz -C /tmp "bin/limactl"
  mv /tmp/bin/limactl "$VENDOR/bin/limactl"
  chmod +x "$VENDOR/bin/limactl"
fi
if [[ ! -x "$VENDOR/bin/docker" ]]; then
  curl -sL "https://download.docker.com/mac/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VER}.tgz" -o /tmp/docker.tgz
  tar -xzf /tmp/docker.tgz -C /tmp
  mv /tmp/docker/docker "$VENDOR/bin/docker"
  chmod +x "$VENDOR/bin/docker"
fi

if command -v brew >/dev/null 2>&1; then
  if ! command -v qemu-img >/dev/null 2>&1; then
    echo "==> brew install qemu (disk tooling for Colima/Lima)"
    brew install qemu || echo "warn: brew install qemu failed — Colima may need qemu-img on PATH"
  fi
else
  echo "warn: brew not found — ensure qemu-img is on PATH before colima start"
fi

echo "==> colima start (cpu=2 mem=4 vz)"
export DOCKER_HOST="unix://${COLIMA_HOME}/default/docker.sock"
if ! colima status 2>/dev/null | grep -qi running; then
  colima start --cpu 2 --memory 4 --vm-type=vz || colima start --cpu 2 --memory 4
fi

echo "==> smoke: docker run hello-world"
docker run --rm hello-world

echo ""
echo "OK — local infra ready."
echo "  PATH exports (add to shell rc or agent env):"
echo "    export PATH=\"$FOUNDRY_DIR/bin:$VENDOR/bin:\$PATH\""
echo "    export COLIMA_HOME=\"$COLIMA_HOME\""
echo "    export LIMA_HOME=\"$LIMA_HOME\""
echo "    export DOCKER_HOST=\"unix://${COLIMA_HOME}/default/docker.sock\""
echo "  Then: pnpm verify"
