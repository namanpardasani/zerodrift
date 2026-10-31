# One recipe for every Node service:   docker build --build-arg SERVICE=ledger .
#
# Stage 1 builds the whole workspace, then `pnpm deploy` assembles ONLY what this service needs at runtime:
# its compiled code and its production dependencies (workspace packages included). No dev tooling, no
# other services, no sources of tests. Stage 2 ships just that on a slim base.
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate || npm i -g pnpm@12.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build
ARG SERVICE
RUN pnpm --filter "@zerodrift/${SERVICE}" deploy --prod /out \
 && mkdir -p /out/static \
 && case "$SERVICE" in \
      dashboard-api) cp -r apps/dashboard/dist/. /out/static/ ;; \
      demo-shop)     cp -r apps/shop/dist/. /out/static/ ;; \
    esac \
 && rm -rf /out/src /out/test /out/tsconfig*.json /out/vitest.config.mts /out/pnpm-workspace.yaml /out/pnpm-lock.yaml

FROM node:24-slim
ARG SERVICE
# DNS lookups run on libuv's threadpool (default 4 threads). A few slow lookups of a dead dependency's name
# (Docker DNS can take seconds to fail) would otherwise block EVERY other outbound call of the service.
ENV SERVICE=${SERVICE} NODE_ENV=production UV_THREADPOOL_SIZE=32 STATIC_DIR=/app/static
WORKDIR /app
COPY --from=build /out /app
# Never run as root: a compromised service then cannot modify the image or reach host-level resources.
USER node
CMD ["node", "dist/main.js"]
