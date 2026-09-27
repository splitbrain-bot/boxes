# Orchestrator image. It also bundles the dashboard, which the orchestrator
# serves as static files on the same origin as the API and the gateway.
#
# Every bundle step type-checks first, so failing code cannot become an image.

FROM node:26-bookworm AS dashboard-build
WORKDIR /build
COPY shared/ ./shared/
COPY dashboard/package.json dashboard/package-lock.json* ./dashboard/
WORKDIR /build/dashboard
# ci, so the image uses the lock file versions.
RUN npm ci
COPY dashboard/ ./
# check:app, because the full check also covers the browser suite, which
# needs the orchestrator's source.
RUN npm run check:app && npm run build

# --- orchestrator ------------------------------------------------------------
FROM node:26-bookworm AS orchestrator-build
WORKDIR /build
COPY shared/ ./shared/
COPY orchestrator/package.json orchestrator/package-lock.json* ./orchestrator/
WORKDIR /build/orchestrator
RUN npm ci
COPY orchestrator/ ./
RUN npm run check && npm run build

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 is a native module, so the production dependencies are
# installed against the runtime image's own libc.
COPY orchestrator/package.json orchestrator/package-lock.json* ./
# git stays, because the review runs it over a box's workspace. The native
# module's build toolchain is installed and removed in the same layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.npm

COPY --from=orchestrator-build /build/orchestrator/dist ./dist
COPY --from=dashboard-build /build/dashboard/dist ./dashboard

EXPOSE 3000
CMD ["node", "dist/index.js"]
