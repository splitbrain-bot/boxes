# Image of the egress proxy.
#
# The build stage copies the repository layout, so the imports from proxy/src
# into shared/ resolve as they do in a checkout.
FROM node:26-alpine AS build
WORKDIR /build
COPY proxy/package.json proxy/package-lock.json* ./proxy/
WORKDIR /build/proxy
RUN npm ci
# Copied after npm ci, so a change in shared/ keeps the cached npm ci layer.
COPY shared/ /build/shared/
COPY proxy/tsconfig.json proxy/vite.config.ts ./
COPY proxy/src ./src
RUN npm run check && npm run build

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The bundle keeps the npm dependencies external, so this stage installs them.
COPY proxy/package.json proxy/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/proxy/dist/main.js ./main.js
USER node
# EXPOSE lists only the proxy port, because only the orchestrator uses the
# control port.
EXPOSE 3128
CMD ["node", "main.js"]
