# svc-ledger, the Rust service. Not the Node fleet image: one binary on a slim Debian, as non-root, like svc-tax's and
# svc-academy's. Built from the workspace root (context `.`): the workspace manifest, its lockfile and the pinned toolchain
# decide the build, `--locked` refuses a lockfile that does not match. The binary serves (`svc-ledger`) and applies the
# `ledger` schema's migrations (`svc-ledger migrate`), which compose runs once before the service starts.

FROM rust:1.100.0-slim-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
# One build at a time holds the shared cargo caches: compose builds these images in parallel, and two cargo runs
# unpacking the same crate into one registry cache fail with "File exists (os error 17)" (#6853).
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p svc-ledger \
    && cp target/release/svc-ledger /svc-ledger

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /svc-ledger /app/svc-ledger
USER nobody
CMD ["/app/svc-ledger"]
