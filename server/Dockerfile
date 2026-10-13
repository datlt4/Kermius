FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/kermius-sync /usr/local/bin/kermius-sync
RUN mkdir /data && chown 65534:65534 /data
ENV KERMIUS_DATA=/data KERMIUS_ADDR=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
USER 65534:65534
CMD ["kermius-sync"]
