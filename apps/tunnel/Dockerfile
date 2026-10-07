# syntax=docker/dockerfile:1.7
FROM rust:bookworm AS builder

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
    && cp /app/target/release/pi-desk-tunnel-server /app/pi-desk-tunnel-server

FROM debian:bookworm-slim

RUN useradd --create-home --uid 10001 pi-desk-tunnel
COPY --from=builder /app/pi-desk-tunnel-server /usr/local/bin/pi-desk-tunnel-server
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/pi-desk-tunnel/
COPY licenses/ /usr/share/doc/pi-desk-tunnel/licenses/

USER pi-desk-tunnel
EXPOSE 7001/tcp 7002/tcp
CMD ["pi-desk-tunnel-server"]
