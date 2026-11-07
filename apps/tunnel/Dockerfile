# syntax=docker/dockerfile:1.7
FROM rust:1.91-bookworm AS builder
ENV CARGO_BUILD_JOBS=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang cmake pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY client/Cargo.toml client/Cargo.toml
COPY client/src client/src
COPY common/Cargo.toml common/Cargo.toml
COPY common/src common/src
COPY server/Cargo.toml server/Cargo.toml
COPY server/src server/src
RUN --mount=type=cache,id=pi-desk-tunnel-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=pi-desk-tunnel-cargo-target-${TARGETARCH},target=/app/target,sharing=locked \
    cargo build --locked --release --config profile.release.strip=true --package pi-desk-tunnel-server \
    && install -D /app/target/release/pi-desk-tunnel-server /out/pi-desk-tunnel-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 pi-desk-tunnel \
    && install -d -o 10001 -g 10001 /data
COPY --from=builder /out/pi-desk-tunnel-server /usr/local/bin/pi-desk-tunnel-server
COPY --chmod=755 docker-start.sh /usr/local/bin/pi-desk-tunnel-start
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/pi-desk-tunnel/
COPY licenses/ /usr/share/doc/pi-desk-tunnel/licenses/
USER pi-desk-tunnel
EXPOSE 7001/tcp
CMD ["pi-desk-tunnel-start"]
