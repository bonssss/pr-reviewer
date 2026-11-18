import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { prisma, connectDatabase, disconnectDatabase } from '../src/db/prisma.js';
import { env } from '../src/config/env.js';

describe('Phase 1: Project Setup Verification', () => {
  const app = createApp();

  beforeAll(async () => {
    await connectDatabase();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it('should load environment configuration properly', () => {
    expect(env.PORT).toBeDefined();
    expect(env.DATABASE_URL).toBeDefined();
    expect(['development', 'test', 'production']).toContain(env.NODE_ENV);
  });

  it('should connect to PostgreSQL and execute a raw query via Prisma', async () => {
    const result = await prisma.$queryRaw<Array<{ connected: number }>>`SELECT 1 as connected`;
    expect(result).toBeDefined();
    expect(result.length).toBe(1);
    expect(result[0]?.connected).toBe(1);
  });

  it('should verify the database tables exist in PostgreSQL schema', async () => {
    const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public';
    `;
    const tableNames = tables.map((t) => t.tablename);
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('installations');
    expect(tableNames).toContain('repositories');
    expect(tableNames).toContain('pull_requests');
    expect(tableNames).toContain('review_sessions');
    expect(tableNames).toContain('review_comments');
  });

  it('GET / should return 200 OK with service metadata', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('AI-Powered GitHub Pull Request Reviewer API');
    expect(res.body.status).toBe('online');
    expect(res.body.version).toBe('1.0.0');
  });

  it('GET /health should return 200 OK and healthy status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.database).toBe('connected');
  });

  it('GET /non-existent should return 404', async () => {
    const res = await request(app).get('/non-existent-route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Not Found');
  });
});
