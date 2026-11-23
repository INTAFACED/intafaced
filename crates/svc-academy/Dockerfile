# svc-academy, the Rust service. Not the Node fleet image: one static-enough binary on a slim Debian, as non-root.
# Built from the workspace root (context `.`): the workspace manifest, its lockfile and the pinned toolchain decide the
# build, `--locked` refuses a lockfile that does not match. The binary serves (`svc-academy`) and applies the `academy` schema's
# migrations (`svc-academy migrate`), which compose runs once before the service starts.

FROM rust:1.100.0-slim-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p svc-academy \
    && cp target/release/svc-academy /svc-academy

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /svc-academy /app/svc-academy
USER nobody
CMD ["/app/svc-academy"]
