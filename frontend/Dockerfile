# acp-ui web build, served as static files (plan §5, §8.7).
#
# The upstream repo and commit are REQUIRED build args with no defaults: the
# plan pins both (§2, §12.2) and a wrong-but-plausible default would silently
# build an unpinned frontend. Set them in compose.yaml or on the CLI:
#
#   docker build -f frontend/Dockerfile \
#     --build-arg ACP_UI_REPO=https://github.com/<owner>/acp-ui \
#     --build-arg ACP_UI_COMMIT=<40-char sha> .
#
# On upgrade, re-check §2: initialize capabilities, the client-bound method
# set, and WS framing/subprotocol handling.

FROM node:22-bookworm AS build
ARG ACP_UI_REPO
ARG ACP_UI_COMMIT
RUN test -n "$ACP_UI_REPO" || (echo "ERROR: ACP_UI_REPO build arg is required" >&2; exit 1) \
 && test -n "$ACP_UI_COMMIT" || (echo "ERROR: ACP_UI_COMMIT build arg is required" >&2; exit 1)

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git init -q . \
 && git remote add origin "$ACP_UI_REPO" \
 && git fetch --depth 1 origin "$ACP_UI_COMMIT" \
 && git checkout -q FETCH_HEAD

RUN npm ci || npm install

# Telemetry: acp-ui embeds Azure Application Insights. Building with an empty
# connection string means the self-hosted bundle phones home nowhere
# (plan §2, §12.2). The exact var name is upstream's business, so set every
# plausible spelling and then VERIFY below rather than trusting any of them.
ENV APPLICATIONINSIGHTS_CONNECTION_STRING="" \
    VITE_APPLICATIONINSIGHTS_CONNECTION_STRING="" \
    VITE_APPINSIGHTS_CONNECTION_STRING="" \
    VITE_APP_INSIGHTS_CONNECTION_STRING="" \
    VITE_AI_CONNECTION_STRING="" \
    VITE_TELEMETRY_CONNECTION_STRING="" \
    VITE_TELEMETRY_DISABLED="true"

RUN npm run build:web

# Fail the build if a live Application Insights connection string or
# instrumentation key survived into the bundle. This is the actual guarantee
# that the self-hosted frontend is telemetry-free; the env vars above are
# only the attempt.
RUN if grep -rIEl 'InstrumentationKey=[0-9a-fA-F-]{36}|IngestionEndpoint=https' dist-web/ ; then \
      echo "ERROR: Application Insights connection string found in dist-web/" >&2; \
      exit 1; \
    fi \
 && echo "telemetry check passed: no connection string in bundle"

# The dashboard's one-click "Open in acp-ui" button works by writing acp-ui's
# own agent config -- same origin, so same localStorage -- and then
# navigating here. That depends on this storage key, so assert it is really
# the key this build uses. If acp-ui renames it, fail the image build with a
# clear pointer rather than shipping a button that silently does nothing.
ARG ACP_UI_AGENTS_KEY="acp-ui:agents"
RUN if ! grep -rIqF "$ACP_UI_AGENTS_KEY" dist-web/ ; then \
      echo "ERROR: storage key '$ACP_UI_AGENTS_KEY' not found in the acp-ui bundle." >&2; \
      echo "       acp-ui changed its agent-config key. Update STORAGE_KEY in" >&2; \
      echo "       dashboard/src/acpui.ts and the ACP_UI_AGENTS_KEY build arg." >&2; \
      exit 1; \
    fi \
 && echo "storage key check passed: $ACP_UI_AGENTS_KEY present in bundle"

FROM nginx:1.27-alpine AS runtime
COPY --from=build /src/dist-web /usr/share/nginx/html
# Served under /ui behind Traefik; the SPA needs an index fallback.
RUN printf '%s\n' \
  'server {' \
  '  listen 8080;' \
  '  root /usr/share/nginx/html;' \
  '  index index.html;' \
  '  location / { try_files $uri $uri/ /index.html; }' \
  '}' > /etc/nginx/conf.d/default.conf \
 && sed -i 's/listen       80;/listen 8080;/' /etc/nginx/conf.d/default.conf 2>/dev/null || true
EXPOSE 8080
