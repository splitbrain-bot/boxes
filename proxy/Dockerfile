# The egress proxy: type-checked, bundled, and run as a non-root user.
#
# The build mirrors the repository layout so that proxy/src and shared/ resolve
# each other exactly as they do in a checkout.
FROM node:22-alpine AS build
WORKDIR /build
COPY shared/ ./shared/
COPY proxy/package.json proxy/package-lock.json* ./proxy/
WORKDIR /build/proxy
RUN npm ci
COPY proxy/tsconfig.json proxy/vite.config.ts ./
COPY proxy/src ./src
RUN npm run check && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# mockttp is left external by the bundle, so its tree is installed here rather
# than flattened into one file.
COPY proxy/package.json proxy/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/proxy/dist/main.js ./main.js
USER node
EXPOSE 3128 3129
CMD ["node", "main.js"]
