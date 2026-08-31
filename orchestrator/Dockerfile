# The dashboard is bundled here and copied into the runtime image, which
# serves it as static files alongside the API and the gateway. One image, one
# origin, one published port, with no reverse proxy needed in front of it.
#
# Type-checking runs before every bundle step, so an image cannot be built
# from code that fails it.

FROM node:22-bookworm AS dashboard-build
WORKDIR /build
COPY shared/ ./shared/
COPY dashboard/package.json dashboard/package-lock.json* ./dashboard/
WORKDIR /build/dashboard
# ci, not install: the image is built from the dependency versions this commit
# resolved, including the exactly-pinned assistant-ui packages.
RUN npm ci
COPY dashboard/ ./
RUN npm run check && npm run build

# --- orchestrator ------------------------------------------------------------
FROM node:22-bookworm AS orchestrator-build
WORKDIR /build
COPY shared/ ./shared/
COPY orchestrator/package.json orchestrator/package-lock.json* ./orchestrator/
WORKDIR /build/orchestrator
RUN npm ci
COPY orchestrator/ ./
RUN npm run check && npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 is a native module, so production deps are installed against
# the runtime image's own libc.
COPY orchestrator/package.json orchestrator/package-lock.json* ./
# git stays in the runtime image: the review surface runs it over a session's
# workspace, as an ordinary child process with a fixed argv and a scrubbed
# environment (orchestrator/src/review/git.ts). The build-only toolchain for
# the native module is installed and removed in the same layer.
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
