import type { FastifyPluginAsync } from 'fastify';
import type { GetTenantUseCase } from '../../../application/tenant/GetTenantUseCase.js';
import type { UpdateTenantUseCase } from '../../../application/tenant/UpdateTenantUseCase.js';
import type { ConnectWhatsAppUseCase } from '../../../application/tenant/ConnectWhatsAppUseCase.js';
import { ok, sendDomainError } from '../reply.js';

interface TenantRoutesDeps {
  getTenantUseCase: GetTenantUseCase;
  updateTenantUseCase: UpdateTenantUseCase;
  connectWhatsAppUseCase: ConnectWhatsAppUseCase;
}

export const tenantRoutes: FastifyPluginAsync<TenantRoutesDeps> = async (fastify, opts) => {
  // Every route requires JWT auth.
  fastify.addHook('preHandler', fastify.authenticate);

  /**
   * GET /api/v1/tenant
   */
  fastify.get('/', async (request, reply) => {
    try {
      const tenant = await opts.getTenantUseCase.execute(request.tenantId);
      ok(reply, {
        id: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        status: tenant.status,
        whatsapp: {
          connected: Boolean(tenant.phoneNumberId),
          waba_id: tenant.wabaId,
          phone_number_id: tenant.phoneNumberId,
        },
      });
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /**
   * PATCH /api/v1/tenant
   */
  fastify.patch<{ Body: { name: string } }>('/', async (request, reply) => {
    try {
      const tenant = await opts.updateTenantUseCase.execute(request.tenantId, {
        name: request.body.name,
      });
      ok(reply, { id: tenant.id, name: tenant.name, plan: tenant.plan, status: tenant.status });
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /**
   * POST /api/v1/tenant/whatsapp/connect
   *
   * Manual onboarding path (no Embedded Signup). The credentials are now
   * verified against Meta before being stored, and the caller must be
   * owner/admin because this rebinds the tenant's messaging channel.
   */
  fastify.post<{
    Body: { waba_id: string; phone_number_id: string; access_token: string };
  }>(
    '/whatsapp/connect',
    { preHandler: [fastify.authorize('owner', 'admin')] },
    async (request, reply) => {
      try {
        const result = await opts.connectWhatsAppUseCase.execute(request.tenantId, {
          wabaId: request.body.waba_id,
          phoneNumberId: request.body.phone_number_id,
          accessToken: request.body.access_token,
        });
        ok(reply, result);
      } catch (err) {
        sendDomainError(reply, err);
      }
    },
  );
};
