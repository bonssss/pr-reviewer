# 🤖 AI-Powered GitHub Pull Request Reviewer

An AI reviewer that analyses pull requests, finds bugs and security problems, and
publishes actionable inline comments on GitHub. It ships with a tenant-aware
REST API, a hardened webhook pipeline, an asynchronous review worker, and a
small static dashboard.

![Node.js](https://img.shields.io/badge/Node.js-24+-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-blue.svg)
![Prisma](https://img.shields.io/badge/Prisma-5.22-darkblue.svg)
![OpenAI](https://img.shields.io/badge/OpenAI-gpt--4o--mini-purple.svg)
![Tests](https://img.shields.io/badge/Tests-118%20Passed-brightgreen.svg)

---

## Features

- **GitHub App integration** — HMAC-SHA256 webhook verification on the raw
  request body, per-installation Octokit tokens, installation lifecycle
  handling (created / suspended / deleted).
- **Idempotent webhooks** — every `X-GitHub-Delivery` is recorded in
  `WebhookDelivery`; retries are acknowledged without triggering a second
  review. Reviews are further de-duplicated per `(pull request, commit SHA)`.
- **Asynchronous review worker** — bounded concurrency, retries with backoff,
  stale-session recovery on startup, graceful shutdown, and no duplicate work
  for the same commit.
- **AI review pipeline** — diff parsing and filtering, prompt-injection
  hardening, strict JSON schema validation, severity classification
  (`CRITICAL` / `HIGH` / `MEDIUM` / `LOW`), and a timeout/retry budget.
- **Secret filtering** — `.env`, key material, cloud credentials and
  generated artefacts are stripped from the diff *before* it is sent to the AI
  provider. Patches that still look like they contain credentials are dropped.
- **Safe publishing** — markdown is escaped, suggestion blocks cannot break out
  of their code fences, inline comments are validated against the diff, and
  422 failures fall back to a single issue comment. Publishing is idempotent
  and limited to one review per `(pull request, commit SHA)`, so re-reviewing
  an unchanged commit does not spam the PR with identical reviews.
- **Tenant isolation** — a user can only see repositories they own or that
  belong to an installation they connected. Other tenants' resources return
  `404`, never `403`.
- **Security hardening** — HS256-pinned JWTs with fixed issuer/audience, OAuth
  `state` CSRF protection, AES-256-GCM encryption of GitHub tokens at rest,
  allow-listed CORS, strict CSP, rate limiting, trusted-origin checks for
  cookie-authenticated state changes, and production env validation.
- **Dashboard** — dependency-free vanilla JS, locally built Tailwind CSS (no
  CDN, no inline scripts), sanitised rendering, an auth gate, and delegated
  `data-action` handlers.

---

## Repository layout

```
pr-reviewer/
├── backend/                     # Express + TypeScript API
│   ├── src/
│   │   ├── config/              # env validation, logger, rate limiters
│   │   ├── db/                  # Prisma client + connection manager
│   │   ├── modules/
│   │   │   ├── auth/            # OAuth, JWT, tenant access helpers
│   │   │   ├── ai/              # OpenAI service, prompt builder, schemas
│   │   │   ├── github/          # GitHub App client, diff fetching
│   │   │   ├── repositories/    # repository list/sync/settings
│   │   │   ├── reviews/         # review sessions + publisher
│   │   │   └── dashboard/       # aggregate metrics & PR explorer
│   │   ├── utils/               # diff parser, crypto, HTTP errors
│   │   ├── webhooks/            # raw-body verifier & handlers
│   │   └── workers/             # background review queue
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/          # 0001_init (used by Docker production)
│   └── tests/                   # Vitest unit / integration / security / e2e
├── frontend/                    # Static dashboard (Vite + local Tailwind)
│   ├── index.html
│   ├── app.js
│   ├── sanitize.js
│   ├── styles.css
│   ├── src/input.css            # Tailwind source
│   ├── tailwind.config.js
│   └── nginx.conf
├── docker/backend-entrypoint.sh # prisma migrate deploy, then start API
├── docker-compose.yml
└── .github/workflows/ci.yml
```

The repo is an **npm workspace monorepo**; `package-lock.json` lives at the
root and Docker images are built from the repository root context.

---

## Quick start (local)

Requirements: Node.js 24+, PostgreSQL 15+.

```bash
npm ci
cp backend/.env.example backend/.env     # then fill in the secrets
npm run db:generate
npm run db:push                          # or: npm run db:migrate
npm run dev:all                          # backend :3000, dashboard :5173
```

The backend also serves the dashboard source at `http://localhost:3000/dashboard`,
which is convenient when you do not want to run Vite.

### Environment

All variables are validated with Zod at boot (`backend/src/config/env.ts`). In
production the process refuses to start unless:

- `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY` are at least 32 characters and not
  the development default,
- `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
  `GITHUB_WEBHOOK_SECRET` (≥16 chars) and `OPENAI_API_KEY` are set,
- `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_PATH` is provided,
- `FRONTEND_URL` uses `https://` (plain `http://localhost` is allowed for
  local single-host deployments).

See `backend/.env.example` for every option.

If `OPENAI_API_KEY` is missing, empty, or set to `mock_openai_api_key`, the
backend does **not** call a model. It falls back to a deterministic offline
heuristic engine that only flags hardcoded credentials, `eval()`, and
`console.log`. Those reviews are labelled `heuristic-engine` and say so in the
summary, so they are never mistaken for a full AI review.

### AI provider

The review engine speaks the OpenAI chat-completions format, so any
OpenAI-compatible provider works. Set `OPENAI_BASE_URL` and `OPENAI_MODEL`
alongside `OPENAI_API_KEY`:

| Provider | `OPENAI_BASE_URL` | Example model |
| --- | --- | --- |
| OpenAI | *(empty)* | `gpt-4o-mini` |
| Google Gemini (free tier) | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` |
| Groq (free tier) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | any `:free` model id |
| Ollama (local, no key) | `http://localhost:11434/v1` | `llama3.2` |

The model must return JSON; the prompt already requests it and the response is
validated against a strict schema.

### GitHub App setup

1. Create a **GitHub App** (not a separate OAuth App) and note its **App ID**,
   **Client ID**, **Client secret**, and generate a **private key**. Use the
   credentials shown on the GitHub App page — GitHub Apps provide their own
   OAuth client ID/secret, and mixing them with a separate OAuth App's
   credentials causes GitHub to return `invalid_client`.
2. Set the OAuth callback URL to
   `${BACKEND_URL}/api/auth/github/callback`.
3. Set the webhook URL to `${BACKEND_URL}/api/webhooks/github` and choose a
   webhook secret.
4. Grant read access to contents, pull requests and metadata.
5. Put the values in `backend/.env`, install the app on a repository, and sign
   in through the dashboard.

---

## API overview

All data endpoints require a session (httpOnly `token` cookie or
`Authorization: Bearer <jwt>`).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/health` | Liveness + database probe |
| `GET` | `/api/auth/github` | Start OAuth (state cookie) |
| `GET/POST` | `/api/auth/github/callback` | Finish OAuth, set session cookie |
| `GET` | `/api/auth/me` | Current user |
| `POST` | `/api/auth/logout` | Clear session (trusted origin required) |
| `GET` | `/api/repositories` | List accessible repositories |
| `POST` | `/api/repositories/sync/:installationId` | Sync installation repos |
| `GET` | `/api/repositories/:id` | Repository details + metrics |
| `PATCH` | `/api/repositories/:id` | Update prompt / auto-review |
| `GET` | `/api/reviews/session/:sessionId` | Full review report |
| `GET` | `/api/reviews/pr/:prId/history` | Review history for a PR |
| `POST` | `/api/reviews/pr/:prId/rerun` | Queue a new review |
| `POST` | `/api/reviews/session/:sessionId/publish` | Re-publish a review |
| `GET` | `/api/dashboard/stats` | Aggregate metrics |
| `GET` | `/api/dashboard/prs` | PR explorer feed |
| `POST` | `/api/webhooks/github` | GitHub webhook receiver |

Errors use a consistent shape:

```json
{ "error": "Not Found", "code": "NOT_FOUND" }
```

---

## Database

- Development / CI / tests use `prisma db push`.
- Production (Docker) uses the committed migration:

```bash
npm run db:deploy     # prisma migrate deploy
```

The backend container runs `prisma migrate deploy` automatically before the API
starts (`RUN_MIGRATIONS=false` disables this if migrations are applied by a
separate release job).

Tokens are stored encrypted (`v1.<iv>.<tag>.<ciphertext>`, AES-256-GCM).
Legacy plaintext values are still readable and get re-encrypted the next time
the user signs in.

---

## Testing

```bash
npm test                     # backend Vitest suite
npm run lint                 # backend tsc --noEmit + frontend syntax checks
npm run build:backend
npm run build:frontend
```

The suite runs with `--fileParallelism=false` because it uses one PostgreSQL
database. It is hermetic with respect to third parties: `GitHubService` reports
itself unconfigured and the review worker short-circuits under `VITEST`, so no
GitHub or OpenAI calls are made.

Coverage includes:

- HMAC verification, webhook idempotency, retry and lifecycle transitions,
- tenant isolation (cross-tenant reads/writes return 404),
- JWT algorithm/issuer/audience/expiry pinning, `alg:none` rejection,
- AES-GCM round-trip, tamper detection and legacy passthrough,
- diff secret filtering and inline-comment line validation,
- publisher idempotency and suggestion-fence escaping,
- production env validation, rate limiting, CSRF origin checks,
- CSP/CORS/error-shape hardening,
- frontend HTML escaping and URL sanitisation.

---

## Docker

```bash
cp .env.docker.example .env      # fill in every required value
docker compose up --build
```

- `postgres` is not published to the host; only the backend can reach it.
- `backend` is not published either; the `frontend` Nginx container proxies
  `/api/*` and `/health` to it and publishes `${HTTP_PORT:-80}`.
- The backend applies migrations on startup and runs as the unprivileged
  `node` user.
- Both images are built from the repository root (workspace lockfile) and are
  built in CI on every push/PR.

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `POSTGRES_PASSWORD` | yes | database password |
| `JWT_SECRET` | yes | ≥32 chars |
| `TOKEN_ENCRYPTION_KEY` | yes | ≥32 chars |
| `GITHUB_APP_ID` | yes | GitHub App id |
| `GITHUB_CLIENT_ID` | yes | OAuth client id |
| `GITHUB_CLIENT_SECRET` | yes | OAuth client secret |
| `GITHUB_WEBHOOK_SECRET` | yes | ≥16 chars |
| `OPENAI_API_KEY` | yes | OpenAI key |
| `GITHUB_PRIVATE_KEY` / `GITHUB_PRIVATE_KEY_PATH` | one of | GitHub App key |
| `BACKEND_URL`, `FRONTEND_URL` | recommended | public URLs |
| `HTTP_PORT` | no | host port for the dashboard (default `80`) |

---

## Security notes

- Never commit `.env` files or `*.pem` keys; `.dockerignore` and `.gitignore`
  exclude them from images and git.
- Rotate `JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GITHUB_WEBHOOK_SECRET` and the
  GitHub App private key if they are ever exposed.
- Rotating `TOKEN_ENCRYPTION_KEY` makes existing stored tokens unreadable;
  affected users simply sign in again.
- The dashboard never renders untrusted API data as HTML without escaping and
  only turns absolute `https://` URLs into links.

---

## License

MIT
