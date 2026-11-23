# svc-matching, the Rust service. Not the Node fleet image: one binary on a slim Debian, as non-root, like svc-ledger's,
# svc-tax's and svc-academy's. Built from the workspace root (context `.`): the workspace manifest, its lockfile and the
# pinned toolchain decide the build, `--locked` refuses a lockfile that does not match. There is no database: the engine
# journal lives on the `matchingjournal` volume at /data/matching, which the process must be able to write.

FROM rust:1.100.0-slim-bookworm AS build
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/src/target,sharing=locked \
    cargo build --release --locked -p svc-matching \
    && cp target/release/svc-matching /svc-matching

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# uid 1000 is the Node image's `node`, which wrote the journal volume before this image served it: the same owner keeps
# that journal the engine's to replay and append to. A fresh volume takes this directory's owner.
RUN mkdir -p /data/matching && chown -R 1000:1000 /data
WORKDIR /app
COPY --from=build /svc-matching /app/svc-matching
USER 1000:1000
CMD ["/app/svc-matching"]
