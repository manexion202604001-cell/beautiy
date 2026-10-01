# syntax=docker/dockerfile:1.7
# Salon OS API / worker image (same image, different command)
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @salon/api...

FROM deps AS build
COPY apps/api apps/api
RUN pnpm --filter @salon/api build && pnpm --filter @salon/api deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
# API:    docker run ... (default)
# Worker: docker run ... node dist/worker.js
# Migrate: docker run ... node dist/db/migrate.js
CMD ["node", "dist/index.js"]
