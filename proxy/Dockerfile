# The egress proxy: type-checked, bundled to a single file, and run as a
# non-root user.
FROM node:22-alpine AS build
WORKDIR /build
COPY proxy/package.json ./
RUN npm install
COPY proxy/tsconfig.json proxy/vite.config.ts ./
COPY proxy/src ./src
RUN npm run check && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build /build/dist/main.js ./main.js
USER node
EXPOSE 3128
CMD ["node", "main.js"]
