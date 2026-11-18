import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Prisma } from '@prisma/client';

/**
 * Small, dependency-free HTTP error model plus helpers used across the API so
 * every route answers with a consistent status code and JSON error shape.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, code = 'APP_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message = 'Bad Request', details?: unknown) =>
  new AppError(400, message, 'BAD_REQUEST', details);

export const unauthorized = (message = 'Unauthorized') =>
  new AppError(401, message, 'UNAUTHORIZED');

export const forbidden = (message = 'Forbidden') =>
  new AppError(403, message, 'FORBIDDEN');

export const notFound = (message = 'Not Found') =>
  new AppError(404, message, 'NOT_FOUND');

export const conflict = (message = 'Conflict', details?: unknown) =>
  new AppError(409, message, 'CONFLICT', details);

export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, message, 'RATE_LIMITED');

export const serviceUnavailable = (message = 'Service Unavailable') =>
  new AppError(503, message, 'SERVICE_UNAVAILABLE');

/** Wraps async Express handlers so rejected promises reach the error middleware. */
export function asyncHandler<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req as T, res, next)).catch(next);
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function assertUuid(value: unknown, label = 'id'): string {
  if (!isUuid(value)) {
    throw badRequest(`Invalid ${label}: expected a UUID`);
  }
  return value;
}

export interface Pagination {
  limit: number;
  offset: number;
  page: number;
}

/**
 * Parses `limit`/`offset`/`page` query params with hard caps so a single
 * request can never pull an unbounded amount of rows into memory.
 */
export function parsePagination(
  query: Record<string, unknown>,
  defaults: { limit?: number; maxLimit?: number } = {}
): Pagination {
  const defaultLimit = defaults.limit ?? 50;
  const maxLimit = defaults.maxLimit ?? 200;

  const rawLimit = Number.parseInt(String(query.limit ?? defaultLimit), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : defaultLimit;

  const rawPage = Number.parseInt(String(query.page ?? 1), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawOffset = Number.parseInt(String(query.offset ?? ''), 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : (page - 1) * limit;

  return { limit, offset, page };
}

export function isPrismaError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

/** Converts well-known Prisma failures into correct HTTP status codes. */
export function mapPrismaError(error: unknown): AppError | null {
  if (!isPrismaError(error)) {
    return null;
  }

  switch (error.code) {
    case 'P2025':
      return notFound('The requested resource does not exist');
    case 'P2002':
      return conflict('A resource with these unique fields already exists');
    case 'P2003':
      return badRequest('Invalid reference to a related resource');
    case 'P2024':
      return serviceUnavailable('Database connection pool timed out');
    default:
      return null;
  }
}

export function sendError(res: Response, error: unknown, fallbackMessage = 'Internal Server Error'): void {
  const mapped = error instanceof AppError ? error : mapPrismaError(error);

  if (mapped) {
    res.status(mapped.statusCode).json({
      error: mapped.code,
      message: mapped.message,
      ...(mapped.details !== undefined ? { details: mapped.details } : {}),
    });
    return;
  }

  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: fallbackMessage });
}
