# svc-agents, the Rust service. Not the Node fleet image: one binary on a slim Debian, as non-root, like svc-ledger's,
# svc-tax's and svc-academy's. Built from the workspace root (context `.`): the workspace manifest, its lockfile and the
# pinned toolchain decide the build, `--locked` refuses a lockfile that does not match. The binary serves
# (`svc-agents`) and applies the `agents` schema's migrations (`svc-agents migrate`), which compose runs once before
# the service starts.

FROM rust:1.100.0-slim-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p svc-agents \
    && cp target/release/svc-agents /svc-agents

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /svc-agents /app/svc-agents
USER nobody
CMD ["/app/svc-agents"]
