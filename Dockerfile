# ---- build: compile TypeScript (decorator metadata requires tsc, not esbuild) ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- prod: production dependencies + compiled JS only (shared by migrate and runtime) ----
FROM node:24-alpine AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node

# ---- migrate: one-off job that applies migrations with the compiled data source, then exits ----
FROM prod AS migrate
CMD ["node", "node_modules/typeorm/cli.js", "migration:run", "-d", "dist/database/data-source.js"]

# ---- runtime (last stage = the default for a plain `docker build .`) ----
FROM prod AS runtime
EXPOSE 4003
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4003}/health/live" >/dev/null || exit 1
CMD ["node", "dist/main.js"]
