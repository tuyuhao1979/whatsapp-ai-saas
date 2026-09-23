import type { FastifyPluginAsync } from 'fastify';
import type { DryRunUseCase } from '../../../application/dryrun/DryRunUseCase.js';
import { invalidRequest, ok, sendDomainError } from '../reply.js';
import { dryRunBodySchema, formatIssues } from '../validation.js';

interface DryRunRoutesDeps {
  dryRunUseCase: DryRunUseCase;
}

export const dryrunRoutes: FastifyPluginAsync<DryRunRoutesDeps> = async (fastify, opts) => {
  fastify.addHook('preHandler', fastify.authenticate);

  /** POST /api/v1/dry-run */
  fastify.post<{
    Body: { message: string; simulated_wa_id: string };
  }>('/', async (request, reply) => {
    const parsed = dryRunBodySchema.safeParse(request.body);
    if (!parsed.success) {
      invalidRequest(reply, formatIssues(parsed.error));
      return;
    }

    try {
      const result = await opts.dryRunUseCase.execute({
        tenantId: request.tenantId,
        message: parsed.data.message,
        simulatedWaId: parsed.data.simulated_wa_id,
      });
      ok(reply, result);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });
};
