import type { FastifyPluginAsync } from 'fastify';
import type { StartMetaOnboardingUseCase } from '../../../application/tenant/StartMetaOnboardingUseCase.js';
import type { CompleteMetaOnboardingUseCase } from '../../../application/tenant/CompleteMetaOnboardingUseCase.js';
import type { CheckMetaConnectionUseCase } from '../../../application/tenant/CheckMetaConnectionUseCase.js';
import { ValidationError } from '../../../domain/errors.js';
import { invalidRequest, ok, sendDomainError } from '../reply.js';
import { embeddedSignupCompleteBodySchema, formatIssues } from '../validation.js';

interface MetaRoutesDeps {
  startMetaOnboardingUseCase: StartMetaOnboardingUseCase;
  completeMetaOnboardingUseCase: CompleteMetaOnboardingUseCase;
  checkMetaConnectionUseCase: CheckMetaConnectionUseCase;
  /** True when META_APP_ID + META_CONFIG_ID are configured. */
  embeddedSignupAvailable: boolean;
}

/**
 * Meta WhatsApp onboarding endpoints.
 *
 * Every mutating route requires owner/admin: a viewer being able to rebind the
 * tenant's WhatsApp access token is equivalent to account takeover of the
 * messaging channel.
 */
export const metaRoutes: FastifyPluginAsync<MetaRoutesDeps> = async (fastify, opts) => {
  const ownerOrAdmin = [fastify.authenticate, fastify.authorize('owner', 'admin')];

  /**
   * POST /api/v1/meta/embedded-signup/start
   *
   * Issues a single-use OAuth state bound to this tenant + user and returns the
   * parameters the browser needs to launch the Facebook JS SDK popup.
   */
  fastify.post('/embedded-signup/start', { preHandler: ownerOrAdmin }, async (request, reply) => {
    try {
      if (!opts.embeddedSignupAvailable) {
        throw new ValidationError(
          'Embedded Signup is not configured on this deployment ' +
            '(set META_APP_ID and META_CONFIG_ID), use the manual connect endpoint instead',
        );
      }

      const result = await opts.startMetaOnboardingUseCase.execute({
        tenantId: request.tenantId,
        userId: request.userId,
      });

      ok(reply, result);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /**
   * POST /api/v1/meta/embedded-signup/complete
   *
   * Body: { code, state, waba_id?, phone_number_id? }
   * Exchanges the OAuth code, verifies WABA/phone ownership against Meta,
   * subscribes the webhook and stores the encrypted token.
   */
  fastify.post<{
    Body: {
      code?: string;
      state?: string;
      waba_id?: string;
      phone_number_id?: string;
    };
  }>('/embedded-signup/complete', { preHandler: ownerOrAdmin }, async (request, reply) => {
    const parsed = embeddedSignupCompleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      invalidRequest(reply, formatIssues(parsed.error));
      return;
    }

    try {
      const result = await opts.completeMetaOnboardingUseCase.execute({
        tenantId: request.tenantId,
        code: parsed.data.code,
        state: parsed.data.state,
        wabaId: parsed.data.waba_id,
        phoneNumberId: parsed.data.phone_number_id,
      });

      ok(reply, result);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /**
   * GET /api/v1/meta/connection
   *
   * Live health of the binding (token validity + webhook subscription).
   * Read-only, so any authenticated role may call it.
   */
  fastify.get('/connection', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const status = await opts.checkMetaConnectionUseCase.execute(request.tenantId);
      ok(reply, status);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });
};
