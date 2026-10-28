# One image recipe for every Node service: docker build --build-arg SERVICE=ledger .
# (Slim production images are produced in Phase 12.)
FROM node:24-slim AS build
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate || npm i -g pnpm@12.15.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -r build

FROM node:24-slim
ARG SERVICE
ENV SERVICE=${SERVICE} NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/${SERVICE}
CMD ["node", "dist/main.js"]
