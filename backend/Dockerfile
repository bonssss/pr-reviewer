# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Backend image (build context = repository root, because this is an npm
# workspace monorepo and `npm ci` needs the root lockfile).
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

WORKDIR /app

# Install dependencies for the backend workspace only.
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --workspace=backend --include-workspace-root

# Generate the Prisma client and compile TypeScript.
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/prisma ./backend/prisma
RUN npm run db:generate --workspace=backend

COPY backend/src ./backend/src
RUN npm run build:backend

# ---------------------------------------------------------------------------
# Production runtime
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner

RUN apk add --no-cache dumb-init openssl

WORKDIR /app

ENV NODE_ENV=production

# `prisma` ships with the production dependencies so the container can apply
# pending migrations on startup (`prisma migrate deploy`).
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspace=backend --include-workspace-root

COPY backend/prisma ./backend/prisma
RUN npx prisma generate --schema backend/prisma/schema.prisma

COPY --from=builder /app/backend/dist ./backend/dist
COPY docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh
RUN chmod +x /usr/local/bin/backend-entrypoint.sh

# The unprivileged user must be able to read the generated Prisma client and
# let `prisma migrate deploy` write its engine cache on first boot.
RUN chown -R node:node /app/node_modules /app/backend

WORKDIR /app/backend

# Run as the unprivileged `node` user. The generated Prisma client lives in the
# hoisted /app/node_modules, which the node user can read.
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/usr/local/bin/backend-entrypoint.sh"]
CMD ["node", "dist/server.js"]
