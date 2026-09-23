import type { FastifyReply } from 'fastify';
import {
  ConflictError,
  ForbiddenError,
  MetaApiError,
  NotFoundError,
  ValidationError,
} from '../../src/domain/errors.js';
import { sendDomainError } from '../../src/interfaces/http/reply.js';
import { translatePrismaError } from '../../src/infrastructure/prisma/translatePrismaError.js';

/** The response envelope every error path in reply.ts writes. */
interface ErrorEnvelope {
  data: unknown;
  error: { code: string; message: string; details?: string[] } | null;
  meta: { request_id: string };
}

function fakeReply(): {
  reply: FastifyReply;
  captured: { status?: number; body?: ErrorEnvelope };
} {
  const captured: { status?: number; body?: ErrorEnvelope } = {};
  const reply = {
    status(code: number) {
      captured.status = code;
      return reply;
    },
    send(body: unknown) {
      captured.body = body as ErrorEnvelope;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

// Regression coverage for two mis-mappings that Schemathesis exposed on the
// isolated stack: Prisma unique violations answering 500, and Meta rejecting a
// caller-supplied code answering 502.

describe('translatePrismaError', () => {
  it('maps a unique violation (P2002) to ConflictError', () => {
    const err = translatePrismaError({
      code: 'P2002',
      meta: { target: ['tenant_id', 'name', 'version'] },
    });
    expect(err).toBeInstanceOf(ConflictError);
    expect(err?.message).toContain('tenant_id, name, version');
  });

  it('maps the raw SQLSTATE for a unique violation (23505)', () => {
    expect(translatePrismaError({ code: '23505' })).toBeInstanceOf(ConflictError);
  });

  it('maps a record-not-found (P2025) to NotFoundError', () => {
    expect(translatePrismaError({ code: 'P2025' })).toBeInstanceOf(NotFoundError);
  });

  it('maps a foreign key violation (P2003) to ValidationError', () => {
    expect(translatePrismaError({ code: 'P2003' })).toBeInstanceOf(ValidationError);
  });

  it('maps a CHECK violation (23514) to ValidationError', () => {
    expect(translatePrismaError({ code: '23514' })).toBeInstanceOf(ValidationError);
  });

  it('ignores unrelated errors and non-objects', () => {
    expect(translatePrismaError(new Error('boom'))).toBeNull();
    expect(translatePrismaError({ code: 'P1001' })).toBeNull();
    expect(translatePrismaError(null)).toBeNull();
    expect(translatePrismaError('nope')).toBeNull();
  });

  it('ignores a domain error so reply.ts cannot recurse', () => {
    expect(translatePrismaError(new ConflictError('already there'))).toBeNull();
    expect(translatePrismaError(new ForbiddenError())).toBeNull();
  });
});

describe('sendDomainError', () => {
  it('maps a Prisma unique violation to 409 instead of 500', () => {
    const { reply, captured } = fakeReply();
    sendDomainError(reply, { code: 'P2002', meta: { target: ['tenant_id', 'name', 'version'] } });
    expect(captured.status).toBe(409);
    expect(captured.body?.error?.code).toBe('CONFLICT');
  });

  it.each([400, 401, 403])('maps a Meta %i rejection to 400', (status: number) => {
    const { reply, captured } = fakeReply();
    sendDomainError(reply, new MetaApiError('Invalid verification code', status));
    expect(captured.status).toBe(400);
    expect(captured.body?.error?.message).toBe('Invalid verification code');
  });

  it.each([500, 503, null])('keeps a Meta %p failure as 502', (status: number | null) => {
    const { reply, captured } = fakeReply();
    sendDomainError(reply, new MetaApiError('Meta Graph request failed: timeout', status));
    expect(captured.status).toBe(502);
  });

  it('keeps domain errors on their own status codes', () => {
    const cases: Array<[unknown, number]> = [
      [new NotFoundError('Flow', 'x'), 404],
      [new ConflictError('dup'), 409],
      [new ValidationError('bad', ['n: too short']), 422],
      [new ForbiddenError(), 403],
    ];
    for (const [err, expected] of cases) {
      const { reply, captured } = fakeReply();
      sendDomainError(reply, err);
      expect(captured.status).toBe(expected);
    }
  });

  it('falls back to 500 for a genuinely unknown error', () => {
    const { reply, captured } = fakeReply();
    sendDomainError(reply, new TypeError("Cannot read properties of undefined (reading 'map')"));
    expect(captured.status).toBe(500);
    expect(captured.body?.error?.code).toBe('INTERNAL_ERROR');
    expect(captured.body?.error?.message).not.toContain('Cannot read properties');
  });

  it('always returns a request_id', () => {
    const { reply, captured } = fakeReply();
    sendDomainError(reply, new ConflictError('dup'));
    expect(captured.body?.meta.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
