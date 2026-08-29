# The dashboard and acp-ui are bundled here and copied into the runtime image,
# which serves them as static files alongside the API and the gateway. That
# puts acp-ui on the same origin as the dashboard, which the one-click connect
# needs and which lets the stack run with no reverse proxy in front of it.
#
# Type-checking runs before every bundle step, so an image cannot be built from
# code that fails it.

FROM node:22-bookworm AS dashboard-build
WORKDIR /build
COPY shared/ ./shared/
COPY dashboard/package.json dashboard/package-lock.json* ./dashboard/
WORKDIR /build/dashboard
RUN npm install
COPY dashboard/ ./
RUN npm run check && npm run build

# --- acp-ui ------------------------------------------------------------------
# The acp-ui pin is a build dependency, so it lives here and nowhere else, the
# way session-image/Dockerfile pins the adapter version. No compose or .env
# passthrough reaches it, so the frontend a deployment builds is the one this
# commit names. Changing it is a reviewable commit; a one-off build takes an
# explicit --build-arg.
#
# On upgrade, re-check the initialize capabilities, the client-bound method
# set, and the WebSocket framing and subprotocol handling.
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

# acp-ui hardcodes its Azure Application Insights connection string in source
# rather than reading it from the environment, so blanking it means editing
# that source. An empty string makes the Application Insights constructor
# throw, which acp-ui catches and turns into a disabled client. The grep proves
# the edit landed before the build consumes it.
RUN sed -i "s#^const CONNECTION_STRING = '.*';#const CONNECTION_STRING = '';#" src/lib/telemetry.ts \
 && grep -qF "const CONNECTION_STRING = '';" src/lib/telemetry.ts \
 || (echo "ERROR: could not blank the telemetry connection string in src/lib/telemetry.ts." >&2; \
     echo "       acp-ui changed how it configures Application Insights." >&2; exit 1)

# --base=/ui/ because the orchestrator serves this bundle under that prefix.
# Vite defaults to /, which points the bundle's asset requests at the
# dashboard's routes.
RUN npm run build:web -- --base=/ui/

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

# The dashboard's connect button writes acp-ui's own agent config into the
# shared origin's localStorage, under this key. Assert the key is the one this
# build uses, so a rename upstream fails the build.
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

# better-sqlite3 is a native module, so production deps are installed against
# the runtime image's own libc.
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
