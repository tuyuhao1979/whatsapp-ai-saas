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

  // Upstream Meta failure — 502 so callers can distinguish it from our bugs.
  if (err instanceof MetaApiError) {
    void reply.status(502).send({
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

  // Unknown error — 500
  void reply.status(500).send({
    data: null,
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    meta: { request_id: requestId },
  });
}
