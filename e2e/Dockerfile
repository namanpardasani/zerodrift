# Browser test runner: Node + Playwright's Chromium with all its system libraries, so it runs anywhere
# Docker runs (no sudo/apt needed on the host). Attached to the compose network by e2e/run.sh.
FROM node:24-slim
WORKDIR /e2e
RUN npm init -y >/dev/null && npm install playwright@1.64.1 && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY smoke.mjs ./
CMD ["node", "smoke.mjs"]
