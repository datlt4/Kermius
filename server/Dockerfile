# Build context: repository root (web client + server).
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html vite.config.ts tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npx vite build

FROM rust:1-slim AS build
WORKDIR /src
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/kermius-sync /usr/local/bin/kermius-sync
COPY --from=web /app/dist /web
RUN mkdir /data && chown 65534:65534 /data
ENV KERMIUS_DATA=/data KERMIUS_ADDR=0.0.0.0:8080 KERMIUS_WEB=/web
VOLUME /data
EXPOSE 8080
USER 65534:65534
CMD ["kermius-sync"]
