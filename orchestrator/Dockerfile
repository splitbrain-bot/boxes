# Multi-stage: the dashboard is bundled by esbuild in stage 1 and copied into
# the runtime image, which serves it as static files (plan §8.5).
# Type-checking runs before every bundle step, so an image cannot be built
# from code that fails `tsc --noEmit` (plan §4).

FROM node:22-bookworm AS dashboard-build
WORKDIR /build
COPY shared/ ./shared/
COPY dashboard/package.json dashboard/package-lock.json* ./dashboard/
WORKDIR /build/dashboard
RUN npm install
COPY dashboard/ ./
RUN npm run check && npm run build

FROM node:22-bookworm AS orchestrator-build
WORKDIR /build
COPY shared/ ./shared/
COPY orchestrator/package.json orchestrator/package-lock.json* ./orchestrator/
WORKDIR /build/orchestrator
RUN npm install
COPY orchestrator/ ./
RUN npm run check && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 is a native module, so production deps are installed here
# rather than copied from a build stage with a different libc layout.
COPY orchestrator/package.json orchestrator/package-lock.json* ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm install --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY --from=orchestrator-build /build/orchestrator/dist ./dist
COPY --from=dashboard-build /build/dashboard/dist ./dashboard

EXPOSE 3000
CMD ["node", "dist/index.js"]
