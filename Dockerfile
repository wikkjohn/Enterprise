# syntax=docker/dockerfile:1.7
# Multi-stage build for the web app (Next.js standalone) and the worker.
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ packages/
COPY modules/ modules/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @eaop/web build

# ── web: Next.js standalone server ──────────────────────────────────────────
FROM node:22-bookworm-slim AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 10001 app
COPY --from=build --chown=app /app/apps/web/.next/standalone ./
COPY --from=build --chown=app /app/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ── worker + migrations (TypeScript run via tsx) ────────────────────────────
FROM deps AS worker
ENV NODE_ENV=production
COPY . .
RUN useradd --system --uid 10001 app && chown -R app /app
USER app
CMD ["pnpm", "worker"]
