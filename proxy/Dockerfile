# Same toolchain as the rest of the project: strict TS, type-checked before
# bundling, single bundled file, non-root, read-only root fs (plan §8.4).
FROM node:22-alpine AS build
WORKDIR /build
COPY proxy/package.json ./
RUN npm install
COPY proxy/tsconfig.json ./
COPY proxy/src ./src
RUN npm run check && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /build/dist/main.js ./main.js
USER node
EXPOSE 3128
# No volumes, no runtime deps, nothing to configure.
CMD ["node", "main.js"]
