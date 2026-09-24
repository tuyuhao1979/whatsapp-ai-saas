import fp from 'fastify-plugin';
import fastifyJwt from '@fastify/jwt';
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '../../../config.js';
import { tenantContext } from '../../../infrastructure/prisma/tenantContext.js';
import { isValidTenantId } from '../../../infrastructure/prisma/PrismaClient.js';

export interface JwtPayload {
  sub: string;   // userId
  tid: string;   // tenantId
  role: string;
  exp: number;
}

// Augment Fastify's request to carry tenant context derived from JWT
declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    userId: string;
    userRole: string;
  }
}

const authPluginImpl: FastifyPluginAsync<{ config: Config }> = async (fastify, opts) => {
  await fastify.register(fastifyJwt, {
    secret: opts.config.JWT_SECRET,
    sign: { algorithm: 'HS256' },
  });

  // Decorate request with defaults so TypeScript is happy before the hook runs
  fastify.decorateRequest('tenantId', '');
  fastify.decorateRequest('userId', '');
  fastify.decorateRequest('userRole', '');

  /**
   * Call this hook on any protected route to validate the JWT and bind
   * tenantId / userId / userRole from token claims — NEVER from request body.
   *
   * Callback style (`done`) rather than `async` on purpose: the RLS context is
   * established with `tenantContext.run(tenantId, () => done())`, which is what
   * makes the store visible to the rest of the request.
   *
   * `enterWith()` — the obvious choice — does *not* work here. It only rebinds
   * the execution context that is active when it is called; Fastify resumes the
   * lifecycle from the async resource it created before invoking the hook, so
   * the route handler and every query inside it ran with an empty store. Once
   * row security is actually enforced (the runtime role is no longer the
   * bootstrap superuser) that shows up as `new row violates row-level security
   * policy` on every tenant-scoped write (audit finding H1).
   *
   * Invoking `done()` *inside* the `run` callback makes the continuation — the
   * next hook, then the handler — be created while the store is active, so it
   * and all of its async descendants inherit it.
   */
  fastify.decorate(
    'authenticate',
    (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
      request
        .jwtVerify<JwtPayload>()
        .then((payload) => {
          // Bind claims to request — not from body, not from headers other than Authorization
          request.tenantId = payload.tid;
          request.userId = payload.sub;
          request.userRole = payload.role;

          if (isValidTenantId(payload.tid)) {
            tenantContext.run(payload.tid, () => done());
          } else {
            done();
          }
        })
        .catch(() => {
          reply
            .status(401)
            .send({
              data: null,
              error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
              meta: {},
            })
            .then(
              () => done(),
              () => done(),
            );
        });
    },
  );
};

export const authPlugin = fp(authPluginImpl, {
  name: 'authPlugin',
  fastify: '4.x',
});

// Extend Fastify instance type to include authenticate
declare module 'fastify' {
  interface FastifyInstance {
    authenticate(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void;
  }
}
