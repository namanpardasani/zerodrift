# One image recipe for every Node service: docker build --build-arg SERVICE=ledger .
# (Slim production images are produced in Phase 12.)
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate || npm i -g pnpm@12.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM node:24-slim
ARG SERVICE
# DNS lookups run on libuv's threadpool (default 4 threads). A few slow lookups of a dead dependency's name
# (Docker DNS can take seconds to fail) would otherwise block EVERY other outbound call of the service.
ENV SERVICE=${SERVICE} NODE_ENV=production UV_THREADPOOL_SIZE=32
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/${SERVICE}
CMD ["node", "dist/main.js"]
