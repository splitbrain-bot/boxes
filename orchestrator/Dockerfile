# Multi-stage. The dashboard and acp-ui are both bundled here and copied into
# the runtime image, which serves them as static files alongside the API and
# the gateway (plan §8.5).
#
# Serving acp-ui from this image rather than a second container is what makes
# it the same origin as the dashboard in every deployment. That is what the
# one-click connect needs (dashboard/src/acpui.ts), and it is what lets the
# stack run with no reverse proxy in front of it.
#
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

# --- acp-ui ------------------------------------------------------------------
# The acp-ui pin is a build dependency, so it lives here and nowhere else --
# the same way session-image/Dockerfile pins the adapter version. Deployment
# configuration cannot reach it: there is no passthrough from compose or .env,
# because an overridable pin would let a deployment build a frontend that
# differs from the one version control claims, which is exactly what plan §2
# and §12.2 exist to prevent.
#
# Changing the frontend is therefore a reviewable commit. To try another build
# without committing, pass --build-arg to `docker build` explicitly.
#
# On upgrade, re-check plan §2: initialize capabilities, the client-bound
# method set, and WS framing/subprotocol handling.
FROM node:22-bookworm AS acpui-build
ARG ACP_UI_REPO=https://github.com/formulahendry/acp-ui
# v0.1.16
ARG ACP_UI_COMMIT=cd9c3cb464a4b321bff652101953a64c07473e31
RUN test -n "$ACP_UI_REPO" && test -n "$ACP_UI_COMMIT" \
 || (echo "ERROR: ACP_UI_REPO and ACP_UI_COMMIT must not be empty" >&2; exit 1)

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$ACP_UI_REPO" \
 && git fetch --depth 1 origin "$ACP_UI_COMMIT" \
 && git checkout -q FETCH_HEAD

RUN npm ci || npm install

# Telemetry: acp-ui embeds Azure Application Insights with the connection
# string hardcoded in its source, not read from the environment, so blanking it
# means editing that source. An empty string makes the Application Insights
# constructor throw, which acp-ui already catches and turns into a disabled
# no-op client. The `grep` proves the edit landed before the build consumes it.
RUN sed -i "s#^const CONNECTION_STRING = '.*';#const CONNECTION_STRING = '';#" src/lib/telemetry.ts \
 && grep -qF "const CONNECTION_STRING = '';" src/lib/telemetry.ts \
 || (echo "ERROR: could not blank the telemetry connection string in src/lib/telemetry.ts." >&2; \
     echo "       acp-ui changed how it configures Application Insights." >&2; exit 1)

# `--base=/ui/` because the orchestrator serves this bundle under that prefix.
# Vite defaults to `/`, which would make the bundle request its assets from the
# dashboard's routes and get the dashboard's index.html back instead.
RUN npm run build:web -- --base=/ui/

# The three checks below are the actual guarantees. The steps above are only
# the attempt, and each of these failure modes is silent without them.
RUN if grep -rIEl 'InstrumentationKey=[0-9a-fA-F-]{36}|IngestionEndpoint=https' dist-web/ ; then \
      echo "ERROR: Application Insights connection string found in dist-web/" >&2; \
      exit 1; \
    fi \
 && echo "telemetry check passed: no connection string in bundle"

RUN if ! grep -qF '/ui/assets/' dist-web/index.html ; then \
      echo "ERROR: dist-web/index.html does not reference its assets under /ui/." >&2; \
      echo "       The --base flag did not take effect; the bundle would 404." >&2; \
      exit 1; \
    fi \
 && echo "base path check passed: assets are referenced under /ui/"

# The dashboard's connect button works by writing acp-ui's own agent config --
# same origin, so same localStorage. That depends on this storage key, so
# assert it is really the key this build uses. If acp-ui renames it, fail the
# build with a clear pointer rather than shipping a button that does nothing.
ARG ACP_UI_AGENTS_KEY="acp-ui:agents"
RUN if ! grep -rIqF "$ACP_UI_AGENTS_KEY" dist-web/ ; then \
      echo "ERROR: storage key '$ACP_UI_AGENTS_KEY' not found in the acp-ui bundle." >&2; \
      echo "       acp-ui changed its agent-config key. Update STORAGE_KEY in" >&2; \
      echo "       dashboard/src/acpui.ts and the ACP_UI_AGENTS_KEY build arg." >&2; \
      exit 1; \
    fi \
 && echo "storage key check passed: $ACP_UI_AGENTS_KEY present in bundle"

# --- orchestrator ------------------------------------------------------------
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
COPY --from=acpui-build /src/dist-web ./acpui

EXPOSE 3000
CMD ["node", "dist/index.js"]
