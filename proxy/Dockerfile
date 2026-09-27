# The egress proxy: type-checked, bundled, and run as a non-root user.
#
# The build mirrors the repository layout, so imports from proxy/src into
# shared/ resolve as they do in a checkout.
FROM node:26-alpine AS build
WORKDIR /build
COPY shared/ ./shared/
COPY proxy/package.json proxy/package-lock.json* ./proxy/
WORKDIR /build/proxy
RUN npm ci
COPY proxy/tsconfig.json proxy/vite.config.ts ./
COPY proxy/src ./src
RUN npm run check && npm run build

FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The bundle leaves npm dependencies external, so they are installed here.
COPY proxy/package.json proxy/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/proxy/dist/main.js ./main.js
USER node
# Only the proxy port is advertised. The control port is for the orchestrator
# on the shared network, not for publishing.
EXPOSE 3128
CMD ["node", "main.js"]
