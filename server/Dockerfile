FROM rust:1.89-bookworm AS builder

WORKDIR /app

COPY server/Cargo.toml server/Cargo.lock ./server/
COPY server/src ./server/src
COPY html/dashboard.html ./html/dashboard.html

WORKDIR /app/server
RUN cargo build --release

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/server/target/release/server /usr/local/bin/server

USER 10001:10001

EXPOSE 7878

CMD ["server"]
