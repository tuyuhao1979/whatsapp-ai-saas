import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export type UserRole = 'owner' | 'admin' | 'viewer';

const KNOWN_ROLES: readonly UserRole[] = ['owner', 'admin', 'viewer'];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (KNOWN_ROLES as readonly string[]).includes(value);
}

/**
 * Role-based authorization.
 *
 * The JWT already carried a `role` claim and the schema already constrained it
 * to owner/admin/viewer, but nothing ever read it — every authenticated caller
 * could delete flows, wipe the knowledge base, or overwrite the tenant's
 * WhatsApp access token (audit finding H5).
 *
 * `authenticate` binds `request.userRole` from the verified token; this plugin
 * consumes it. Roles are matched exactly by default, optionally with a minimum
 * rank via `authorizeAtLeast`.
 */
const authorizePluginImpl: FastifyPluginAsync = async (fastify) => {
  fastify.decorate(
    'authorize',
    (...allowed: UserRole[]) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const role = request.userRole;
        if (!isUserRole(role) || !allowed.includes(role)) {
          await reply.status(403).send({
            data: null,
            error: {
              code: 'FORBIDDEN',
              message: 'Your role does not permit this action',
            },
            meta: {},
          });
        }
      },
  );

  fastify.decorate(
    'authorizeAtLeast',
    (minimum: UserRole) =>
      async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const rank: Record<UserRole, number> = { viewer: 1, admin: 2, owner: 3 };
        const role = request.userRole;
        if (!isUserRole(role) || rank[role] < rank[minimum]) {
          await reply.status(403).send({
            data: null,
            error: {
              code: 'FORBIDDEN',
              message: `This action requires the ${minimum} role or higher`,
            },
            meta: {},
          });
        }
      },
  );
};

export const authorizePlugin = fp(authorizePluginImpl, {
  name: 'authorizePlugin',
  fastify: '4.x',
  dependencies: ['authPlugin'],
});

declare module 'fastify' {
  interface FastifyInstance {
    /** Allow only the listed roles. */
    authorize(...allowed: UserRole[]): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Allow the given role and every more privileged role. */
    authorizeAtLeast(minimum: UserRole): (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
