# Stage 1: Build high-performance Rust engine (pure rustls, zero OpenSSL deps)
FROM rust:1-slim-bookworm AS rust-builder
WORKDIR /build/rust-engine
COPY rust-engine/Cargo.toml rust-engine/Cargo.lock* ./
COPY rust-engine/src ./src
RUN cargo build --release

# Stage 2: Build Expo Web frontend
FROM node:22-slim AS web-builder
WORKDIR /build
RUN npm install -g pnpm
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY backend/package.json ./backend/package.json
COPY mobile/package.json ./mobile/package.json
RUN pnpm install --frozen-lockfile
COPY mobile ./mobile
RUN EXPO_NO_TELEMETRY=1 pnpm --filter youanime-mobile exec expo export --platform web --output-dir /build/public

# Stage 3: Minimal production runtime (Rust binary + Expo Web static files)
FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-builder /build/rust-engine/target/release/cinestream-engine /app/cinestream-engine
COPY --from=web-builder /build/public /app/public
ENV HOST=0.0.0.0
ENV PORT=3001
ENV PUBLIC_DIR=/app/public
EXPOSE 3001
CMD ["/app/cinestream-engine"]
