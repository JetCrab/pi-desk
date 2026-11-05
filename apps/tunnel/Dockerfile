# syntax=docker/dockerfile:1.7
FROM rust:1.91-bookworm AS relay-builder
ENV CARGO_BUILD_JOBS=1
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    clang lld cmake pkg-config git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /iroh
RUN git init . \
    && git remote add origin https://github.com/n0-computer/iroh.git \
    && git fetch --depth 1 origin d6c6963b9602d1b8dd2ba53b6519e7eb19cc7940 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = d6c6963b9602d1b8dd2ba53b6519e7eb19cc7940
RUN --mount=type=cache,id=pi-desk-iroh-relay-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=pi-desk-iroh-relay-target-${TARGETARCH},target=/iroh/target,sharing=locked \
    cargo build --locked --release --package iroh-relay --no-default-features --features server,tls-ring \
    && install -D /iroh/target/release/iroh-relay /out/iroh-relay

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
    cargo build --locked --release --package pi-desk-tunnel-server \
    && install -D /app/target/release/pi-desk-tunnel-server /out/pi-desk-tunnel-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 pi-desk-tunnel
COPY --from=builder /out/pi-desk-tunnel-server /usr/local/bin/pi-desk-tunnel-server
COPY --from=relay-builder /out/iroh-relay /usr/local/bin/iroh-relay
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/pi-desk-tunnel/
COPY licenses/ /usr/share/doc/pi-desk-tunnel/licenses/
USER pi-desk-tunnel
EXPOSE 7001/tcp 8080/tcp 8443/tcp 7842/udp
CMD ["pi-desk-tunnel-server"]
