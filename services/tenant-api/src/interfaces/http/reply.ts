import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import {
  DomainError,
  NotFoundError,
  ConflictError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  QuotaExceededError,
  MetaApiError,
  MetaOwnershipError,
  OAuthStateError,
} from '../../domain/errors.js';
import { translatePrismaError } from '../../infrastructure/prisma/translatePrismaError.js';

export interface ApiResponse<T> {
  data: T | null;
  error: { code: string; message: string; details?: string[] } | null;
  meta: { request_id: string };
}

export function ok<T>(reply: FastifyReply, data: T, status = 200): void {
  void reply.status(status).send({
    data,
    error: null,
    meta: { request_id: randomUUID() },
  } satisfies ApiResponse<T>);
}

/**
 * 400 for a request that does not satisfy the documented contract (bad shape,
 * bad type, bad format). Distinct from `ValidationError`'s 422, which the
 * domain raises when the request is well-formed but the *content* is rejected.
 */
export function invalidRequest(
  reply: FastifyReply,
  details: string[],
  message = 'Request validation failed',
): void {
  void reply.status(400).send({
    data: null,
    error: { code: 'INVALID_REQUEST', message, details },
    meta: { request_id: randomUUID() },
  });
}

/** 415 for a request whose content type the endpoint cannot consume. */
export function unsupportedMediaType(reply: FastifyReply, message: string): void {
  void reply.status(415).send({
    data: null,
    error: { code: 'UNSUPPORTED_MEDIA_TYPE', message },
    meta: { request_id: randomUUID() },
  });
}

export function sendDomainError(reply: FastifyReply, err: unknown): void {
  const requestId = randomUUID();

  if (err instanceof NotFoundError) {
    void reply.status(404).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof ConflictError) {
    void reply.status(409).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof ValidationError) {
    void reply.status(422).send({
      data: null,
      error: { code: err.code, message: err.message, details: err.details },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof UnauthorizedError) {
    void reply.status(401).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof ForbiddenError) {
    void reply.status(403).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof QuotaExceededError) {
    void reply.status(429).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  // Ownership could not be proven -> the caller is not allowed to claim this
  // WABA / phone number. 403, not 400: it is an authorisation failure.
  if (err instanceof MetaOwnershipError) {
    void reply.status(403).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof OAuthStateError) {
    void reply.status(400).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  // A Meta failure is only *our* fault when Meta itself failed. When Meta
  // rejects the caller-supplied credential or code with a 4xx — for example
  // "Invalid verification code" during the Embedded Signup token exchange — the
  // request was bad, so answer 400. A 5xx or a network failure stays 502 so
  // callers can tell an upstream outage apart from their own mistake.
  if (err instanceof MetaApiError) {
    const rejectedByUpstream = err.status !== null && err.status >= 400 && err.status < 500;
    void reply.status(rejectedByUpstream ? 400 : 502).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  if (err instanceof DomainError) {
    void reply.status(400).send({
      data: null,
      error: { code: err.code, message: err.message },
      meta: { request_id: requestId },
    });
    return;
  }

  // Persistence errors that carry a well-defined HTTP meaning: unique
  // violations (two flows with the same name), missing referenced rows, CHECK
  // violations. These used to reach the 500 fallback below, so a caller could
  // turn a duplicate name into a server error.
  //
  // Placed after the `DomainError` branch so the recursive call cannot loop: a
  // domain error carries its own `code` ('CONFLICT', 'NOT_FOUND', ...) which is
  // never a Prisma code or SQLSTATE, so it never re-enters this branch.
  const persistenceError = translatePrismaError(err);
  if (persistenceError) {
    sendDomainError(reply, persistenceError);
    return;
  }

  // Unknown error — 500
  void reply.status(500).send({
    data: null,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    meta: { request_id: requestId },
  });
}
