# svc-bank, the Rust service. Not the Node fleet image: one binary on a slim Debian, as non-root, like svc-ledger's,
# svc-tax's and svc-academy's. Built from the workspace root (context `.`): the workspace manifest, its lockfile and the
# pinned toolchain decide the build, `--locked` refuses a lockfile that does not match. The binary serves
# (`svc-bank`) and applies the `bank` schema's migrations (`svc-bank migrate`), which compose runs once before
# the service starts.

FROM rust:1.100.0-slim-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p svc-bank \
    && cp target/release/svc-bank /svc-bank

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /svc-bank /app/svc-bank
USER nobody
CMD ["/app/svc-bank"]
