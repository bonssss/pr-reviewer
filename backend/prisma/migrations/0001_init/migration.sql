-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('USER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "PullRequestState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReviewRecommendation" AS ENUM ('APPROVE', 'REQUEST_CHANGES', 'COMMENT');

-- CreateEnum
CREATE TYPE "IssueSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "IssueCategory" AS ENUM ('BUG', 'SECURITY', 'PERFORMANCE', 'CODE_STYLE', 'TEST_COVERAGE', 'BEST_PRACTICE');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "accessToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installations" (
    "id" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL DEFAULT 'USER',
    "targetId" BIGINT,
    "permissions" JSONB,
    "isSuspended" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_installations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "githubRepoId" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "isPrivate" BOOLEAN NOT NULL DEFAULT false,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "webhookActive" BOOLEAN NOT NULL DEFAULT true,
    "autoReviewEnabled" BOOLEAN NOT NULL DEFAULT true,
    "customPrompt" TEXT,
    "installationId" TEXT,
    "ownerUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" TEXT NOT NULL,
    "githubPrId" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" "PullRequestState" NOT NULL DEFAULT 'OPEN',
    "baseBranch" TEXT NOT NULL,
    "headBranch" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "diffUrl" TEXT,
    "repoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_sessions" (
    "id" TEXT NOT NULL,
    "prId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "riskScore" INTEGER,
    "recommendation" "ReviewRecommendation" NOT NULL DEFAULT 'COMMENT',
    "totalIssues" INTEGER NOT NULL DEFAULT 0,
    "criticalIssues" INTEGER NOT NULL DEFAULT 0,
    "highIssues" INTEGER NOT NULL DEFAULT 0,
    "mediumIssues" INTEGER NOT NULL DEFAULT 0,
    "lowIssues" INTEGER NOT NULL DEFAULT 0,
    "aiModel" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "totalTokens" INTEGER,
    "executionTimeMs" INTEGER,
    "rawAiResponse" JSONB,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "githubReviewId" BIGINT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_comments" (
    "id" TEXT NOT NULL,
    "reviewSessionId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'RIGHT',
    "severity" "IssueSeverity" NOT NULL,
    "category" "IssueCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "suggestion" TEXT,
    "diffHunk" TEXT,
    "githubCommentId" BIGINT,
    "publishedToGithub" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_githubId_key" ON "users"("githubId");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "installations_installationId_key" ON "installations"("installationId");

-- CreateIndex
CREATE INDEX "installations_accountName_idx" ON "installations"("accountName");

-- CreateIndex
CREATE INDEX "user_installations_installationId_idx" ON "user_installations"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "user_installations_userId_installationId_key" ON "user_installations"("userId", "installationId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_githubRepoId_key" ON "repositories"("githubRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_fullName_key" ON "repositories"("fullName");

-- CreateIndex
CREATE INDEX "repositories_installationId_idx" ON "repositories"("installationId");

-- CreateIndex
CREATE INDEX "repositories_ownerUserId_idx" ON "repositories"("ownerUserId");

-- CreateIndex
CREATE INDEX "repositories_updatedAt_idx" ON "repositories"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_githubPrId_key" ON "pull_requests"("githubPrId");

-- CreateIndex
CREATE INDEX "pull_requests_repoId_updatedAt_idx" ON "pull_requests"("repoId", "updatedAt");

-- CreateIndex
CREATE INDEX "pull_requests_state_idx" ON "pull_requests"("state");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repoId_number_key" ON "pull_requests"("repoId", "number");

-- CreateIndex
CREATE INDEX "review_sessions_prId_commitSha_idx" ON "review_sessions"("prId", "commitSha");

-- CreateIndex
CREATE INDEX "review_sessions_prId_createdAt_idx" ON "review_sessions"("prId", "createdAt");

-- CreateIndex
CREATE INDEX "review_sessions_status_createdAt_idx" ON "review_sessions"("status", "createdAt");

-- CreateIndex
CREATE INDEX "review_comments_reviewSessionId_filePath_idx" ON "review_comments"("reviewSessionId", "filePath");

-- CreateIndex
CREATE INDEX "review_comments_reviewSessionId_severity_idx" ON "review_comments"("reviewSessionId", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_deliveryId_key" ON "webhook_deliveries"("deliveryId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_receivedAt_idx" ON "webhook_deliveries"("receivedAt");

-- AddForeignKey
ALTER TABLE "user_installations" ADD CONSTRAINT "user_installations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_installations" ADD CONSTRAINT "user_installations_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "installations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_sessions" ADD CONSTRAINT "review_sessions_prId_fkey" FOREIGN KEY ("prId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_reviewSessionId_fkey" FOREIGN KEY ("reviewSessionId") REFERENCES "review_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

