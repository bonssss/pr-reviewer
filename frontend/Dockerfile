# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Dashboard build (build context = repository root; npm workspace lockfile).
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --workspace=frontend --include-workspace-root

COPY frontend ./frontend
RUN npm run build --workspace=frontend

# ---------------------------------------------------------------------------
# Static runtime
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runner

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
