# 🤖 AI-Powered GitHub Pull Request Reviewer

> Production-ready AI Pull Request Reviewer that automatically analyzes code changes, identifies bugs, security flaws, performance degradation, and code smells, and delivers actionable inline review comments directly on GitHub Pull Requests.

![Node.js](https://img.shields.io/badge/Node.js-v24+-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-blue.svg)
![Prisma](https://img.shields.io/badge/Prisma-5.22-darkblue.svg)
![OpenAI](https://img.shields.io/badge/OpenAI-gpt--4o--mini-purple.svg)
![Docker](https://img.shields.io/badge/Docker-Production--Ready-2496ED.svg)
![Tests](https://img.shields.io/badge/Tests-61%20Passed-brightgreen.svg)

---

## 🌟 Core Features

- **GitHub App Integration:** Secure cryptographic HMAC-SHA256 signature verification (`X-Hub-Signature-256`) and per-installation Octokit token management.
- **Smart Noise & Diff Filtering:** Automatically ignores generated lock files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`), images, binary assets, and minified bundles to minimize token costs.
- **Strict Production AI Guidelines:**
  - Focuses strictly on actual changes in the diff.
  - Zero speculative bug accusations.
  - Generates drop-in GitHub code suggestion blocks (` ```suggestion `).
  - Validates line numbers against actual modified patch hunks.
  - Categorizes findings by severity (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`).
  - Shields against prompt injection by treating all PR diffs as untrusted data.
- **Duplicate Review Prevention:** Inspects existing PR review comments to avoid spamming duplicate comments across iterative review cycles.
- **Developer Re-Review Workflow:** Developers can request fresh automated reviews on demand (`POST /api/reviews/pr/:prId/rerun`).
- **Separated Monorepo Architecture:** Clean separation into `backend/` and `frontend/` services with npm workspaces, unified CLI, and isolated multi-stage Docker builds.
- **Interactive Modern Web Dashboard:** High-performance SPA with Vite build, Nginx reverse proxy, real-time KPI metrics, repository guidelines manager, and one-click code fix copy buttons.
- **Full Relational Audit Trail:** PostgreSQL schema tracking Users, Installations, Repositories, Pull Requests, Review Sessions, and Review Comments.

---

## 🏗️ Monorepo Architecture

```
pr-reviewer/
├── backend/                  # Node.js 24 + Express + TypeScript Backend
│   ├── src/
│   │   ├── config/           # Zod environment validation & Pino logger
│   │   ├── db/               # Prisma client & connection manager
│   │   ├── modules/          # Auth, AI, GitHub, Repositories, Reviews, Dashboard
│   │   ├── utils/            # Diff parser & noise filtering
│   │   ├── webhooks/         # HMAC signature verifier & Webhook handlers
│   │   └── workers/          # Async background queue processor
│   ├── prisma/               # Database schema & migrations
│   ├── tests/                # 61 Vitest unit, integration & E2E tests
│   ├── Dockerfile            # Multi-stage production container with dumb-init
│   ├── package.json
│   └── tsconfig.json
├── frontend/                 # Production Single Page Application Dashboard
│   ├── dist/                 # Production-optimized Vite bundle
│   ├── public/               # Static icons & manifest
│   ├── index.html            # Dashboard UI
│   ├── app.js                # State management, Charts, and API client
│   ├── styles.css            # Dark mode styles & animations
│   ├── nginx.conf            # High-performance Nginx reverse proxy
│   ├── Dockerfile            # Multi-stage build + Nginx Alpine runner
│   ├── vite.config.ts        # Vite development and proxy server
│   └── package.json
├── .github/
│   └── workflows/
│       └── ci.yml            # Automated CI/CD (lint, test, build)
├── docker-compose.yml        # Production Docker Compose orchestration
├── package.json              # Root npm workspaces orchestrator
└── README.md
```

```mermaid
flowchart TD
    subgraph GitHubPlatform["GitHub Ecosystem"]
        Dev[Developer opens/updates PR]
        GHApp[GitHub App Webhooks]
        GHReview[GitHub PR Review Comments]
    end

    subgraph Frontend["Frontend Service (Nginx / Vite)"]
        UI["Modern Web Dashboard\n(Vite SPA on Port 80 / 5173)"]
        NginxProxy["Nginx Reverse Proxy\n(Proxy /api/* to Backend)"]
    end

    subgraph Backend["Backend Service (Node.js 24 + Express)"]
        Ingress["Express Ingress\n(HMAC Signature Verification)"]
        WorkerQueue["Async Background Queue\n(review.worker.ts)"]
        DiffEngine["Diff Parser & Noise Filter\n(diff.parser.ts)"]
        AIEngine["AI Review Engine\n(OpenAI gpt-4o-mini + Zod Schema)"]
        Publisher["Review Publisher\n(Inline Comments & Duplicate Gate)"]
        API["REST APIs (/api/dashboard, /api/reviews, /api/repositories)"]
    end

    subgraph DataStorage["PostgreSQL Database (Prisma ORM)"]
        DB[("PostgreSQL\n• Repositories\n• PullRequests\n• ReviewSessions\n• ReviewComments")]
    end

    Dev -->|Push commits / Open PR| GHApp
    GHApp -->|POST /api/webhooks/github| Ingress
    Ingress -->|202 Accepted within 50ms| GHApp
    Ingress -->|Enqueue| WorkerQueue
    WorkerQueue --> DiffEngine
    DiffEngine --> AIEngine
    AIEngine --> Publisher
    Publisher -->|Create review & inline suggestions| GHReview

    UI --> NginxProxy
    NginxProxy --> API
    Ingress <--> DB
    WorkerQueue <--> DB
    API <--> DB
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js:** v22 or v24+
- **Docker & Docker Compose** (for containerized deployment)
- **PostgreSQL 16+** (if running locally without Docker)
- **GitHub App Credentials** (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`)
- **OpenAI API Key** (optional: automatic fallback engine provided for development and testing)

### 2. Installation
Clone the repository and install all workspace dependencies from root:
```bash
git clone https://github.com/bonssss/pr-reviewer.git
cd pr-reviewer
npm install
```

### 3. Environment Configuration
Create a `.env` file inside `backend/`:
```bash
cp backend/.env.example backend/.env
```
Fill in your configuration:
```ini
NODE_ENV=development
PORT=3000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pr_reviewer?schema=public"
FRONTEND_URL="http://localhost:5173"
JWT_SECRET="your_secure_jwt_secret"

# GitHub App Settings
GITHUB_APP_ID="5815976"
GITHUB_CLIENT_ID="Iv23li5C9BcB9iGMBKGv"
GITHUB_CLIENT_SECRET="your_client_secret"
GITHUB_WEBHOOK_SECRET="your_webhook_secret"
GITHUB_PRIVATE_KEY_PATH="./your-private-key.pem"

# OpenAI Configuration
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4o-mini"
```

### 4. Database Setup
```bash
npm run db:push
```

### 5. Running in Development
Run both backend and frontend concurrently:
```bash
npm run dev:all
```
- **Backend API:** `http://localhost:3000`
- **Frontend Dashboard:** `http://localhost:5173`
- **API Health Check:** `http://localhost:3000/health`

Alternatively, run each service individually:
```bash
npm run dev:backend    # Runs backend on port 3000
npm run dev:frontend   # Runs frontend on port 5173
```

---

## 🐳 Production Deployment with Docker Compose

To deploy the entire production stack (PostgreSQL, Backend, and Frontend Nginx) in one command:

```bash
docker compose up -d --build
```

### Service Map:
| Service | Internal Port | Host Port | Description |
| :--- | :--- | :--- | :--- |
| **frontend** | `80` | `80` (or `5173`) | Nginx serving built SPA & proxying `/api` requests |
| **backend** | `3000` | `3000` | Node.js 24 API runtime (non-root `node` user + dumb-init) |
| **postgres** | `5432` | `5432` | PostgreSQL database with persistent volume & healthchecks |

To stop the services:
```bash
docker compose down
```

---

## 🧪 Testing

The test suite contains **61 automated tests** covering unit, integration, and full lifecycle E2E scenarios across all modules:

```bash
npm test
```

### Test Suite Coverage:
- **Phase 1: Environment & Setup** - Environment loading, database connection, healthcheck endpoints.
- **Phase 2: Auth & Repositories** - JWT signing/verifying, repository settings API, custom guidelines CRUD.
- **Phase 3: Webhooks & Workers** - HMAC cryptographic validation, diff noise filtering, async queue worker.
- **Phase 4: AI Engine** - Zod schema parsing, prompt formatting, heuristic fallback, issue categorization.
- **Phase 5: Publishing & Automation** - Summary Markdown tables, inline ` ```suggestion ` formatting, duplicate comment suppression.
- **Phase 6: Web Dashboard** - KPI metric calculations, PR explorer search, static UI serving.
- **Phase 7: End-to-End PR Lifecycle** - Full mock webhook execution, AI review generation, database audit logging, and re-review request cycle.

---

## 🔒 Security Hardening

- **Atomic State Transitions:** Prevents background workers and webhook jobs from conflicting using atomic PostgreSQL row-level checks (`status: { not: 'COMPLETED' }`).
- **Timing Attack Resistance:** Uses `crypto.timingSafeEqual` for all webhook signature validations.
- **Non-Root Containers:** Backend runs as non-root `node` user; frontend runs on hardened Nginx Alpine.
- **PID 1 Signal Handling:** Backend uses `dumb-init` for graceful shutdown upon `SIGTERM` / `SIGINT`.
- **Content Security & Headers:** Protected via `helmet` and strict Nginx security headers (`X-Frame-Options`, `X-Content-Type-Options`, `X-XSS-Protection`).
- **Secret Isolation:** `.pem` private keys and `.env` files are strictly excluded via `.gitignore`.

---

## 📜 License
MIT
