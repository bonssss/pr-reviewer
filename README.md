# 🤖 AI-Powered GitHub Pull Request Reviewer

> Production-ready AI Pull Request Reviewer that automatically analyzes code changes, identifies bugs, security flaws, performance degradation, and code smells, and delivers actionable inline review comments directly on GitHub Pull Requests.

![Node.js](https://img.shields.io/badge/Node.js-v22+-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-blue.svg)
![Prisma](https://img.shields.io/badge/Prisma-5.22-darkblue.svg)
![OpenAI](https://img.shields.io/badge/OpenAI-gpt--4o--mini-purple.svg)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg)
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
- **Interactive Modern Web Dashboard:** Single-page application built directly into the server (`http://localhost:3000/dashboard`) with real-time KPI metrics, repository guidelines manager, PR review reports, and one-click code fix copy buttons.
- **Full Relational Audit Trail:** PostgreSQL schema tracking Users, Installations, Repositories, Pull Requests, Review Sessions, and Review Comments.

---

## 🏗️ Architecture Overview

```mermaid
flowchart TD
    subgraph GitHubPlatform["GitHub Ecosystem"]
        Dev[Developer opens/updates PR]
        GHApp[GitHub App Webhooks]
        GHReview[GitHub PR Review Comments]
    end

    subgraph ServiceLayer["PR Reviewer Backend (Node.js + TypeScript)"]
        Ingress["Express Ingress\n(HMAC Signature Verification)"]
        WorkerQueue["Async Background Queue\n(review.worker.ts)"]
        DiffEngine["Diff Parser & Noise Filter\n(diff.parser.ts)"]
        AIEngine["AI Review Engine\n(OpenAI gpt-4o-mini + Zod Schema)"]
        Publisher["Review Publisher\n(Inline Comments & Duplicate Gate)"]
        DashboardAPI["Dashboard REST API & SPA Server"]
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
    AIEngine --> DB
    Publisher -->|POST pulls/reviews| GHReview
    DashboardAPI --> DB
```

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- **Node.js**: `v20.x` or higher
- **PostgreSQL**: `v15.x` or higher (or Docker)
- **OpenAI API Key**: (Optional for local development; a built-in heuristic review engine handles offline testing)

### 2. Clone and Install Dependencies
```bash
git clone https://github.com/bonssss/pr-reviewer.git
cd pr-reviewer
npm install
```

### 3. Configure Environment Variables
```bash
cp .env.example .env
```
Populate `.env` with your credentials:
```env
PORT=3000
NODE_ENV=development
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/pr_reviewer?schema=public"
JWT_SECRET="your_secret_jwt_key_here"

# GitHub App Settings
GITHUB_APP_ID="123456"
GITHUB_CLIENT_ID="your_client_id"
GITHUB_CLIENT_SECRET="your_client_secret"
GITHUB_WEBHOOK_SECRET="your_webhook_secret"
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."

# OpenAI Settings
OPENAI_API_KEY="sk-..."
OPENAI_MODEL="gpt-4o-mini"
```

### 4. Database Setup
```bash
# Option A: Start PostgreSQL with Docker
docker-compose up -d postgres

# Option B: Run local script
./scripts/init-db.sh

# Push Prisma schema to PostgreSQL
npm run db:push
```

### 5. Run Development Server
```bash
npm run dev
```
Open **[http://localhost:3000/dashboard](http://localhost:3000/dashboard)** in your browser!

---

## 🧪 Comprehensive Test Suite

The repository contains 61 unit, integration, and end-to-end tests covering all 7 phases:

```bash
# Run all tests
npm test

# Type-check TypeScript code
npm run lint

# Build production bundle
npm run build
```

---

## 🐳 Docker Production Deployment

Run the complete multi-container stack with one command:
```bash
docker-compose up --build -d
```
This automatically initializes:
- **`pr-reviewer-db`**: PostgreSQL container with persistent volume and automatic health checks.
- **`pr-reviewer-api`**: Multi-stage production container running the compiled Node.js backend and dashboard.

---

## 🔧 GitHub App Configuration Guide

To receive webhooks and publish comments to your GitHub repositories:

1. Go to **GitHub Settings &rarr; Developer settings &rarr; GitHub Apps &rarr; New GitHub App**.
2. **Webhook URL**: `https://your-public-domain.com/api/webhooks/github` (or use Smee.io / ngrok for local testing).
3. **Webhook Secret**: Paste the same secret entered in `GITHUB_WEBHOOK_SECRET`.
4. **Permissions**:
   - **Repository &rarr; Pull requests**: `Read & Write` (to fetch diffs and publish review comments)
   - **Repository &rarr; Contents**: `Read-only`
   - **Repository &rarr; Metadata**: `Read-only`
5. **Subscribe to Events**:
   - Check `Pull request`
   - Check `Installation`
   - Check `Installation target`
6. Generate a **Private Key** (`.pem`), download it, and add it to `.env` as `GITHUB_PRIVATE_KEY`.
7. Install the GitHub App on your repositories!

---

## 📡 API Reference Summary

| Method | Endpoint | Description | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/dashboard` | Modern Web Dashboard SPA | Public |
| `GET` | `/health` | Application and PostgreSQL health check | Public |
| `POST` | `/api/webhooks/github` | GitHub Webhook receiver (HMAC-SHA256 verified) | GitHub Signature |
| `GET` | `/api/dashboard/stats` | Aggregated metrics, issue counts, risk score | Optional |
| `GET` | `/api/dashboard/prs` | Filterable pull request review list | Optional |
| `GET` | `/api/repositories` | List connected repositories | Optional |
| `PATCH` | `/api/repositories/:id` | Update auto-review toggle or custom AI guidelines | Required |
| `GET` | `/api/reviews/session/:id` | View full AI review report and inline comments | Optional |
| `GET` | `/api/reviews/pr/:id/history` | Historical review session timeline for a PR | Optional |
| `POST` | `/api/reviews/pr/:id/rerun` | Request an on-demand re-review for a PR | Required |
| `POST` | `/api/reviews/session/:id/publish` | Manually publish review comments to GitHub | Required |

---

## 🛡️ License

MIT License. Designed and built for engineering teams seeking reliable, high-precision automated code reviews.
