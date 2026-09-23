import type { FastifyPluginAsync } from 'fastify';
import type { RegisterUseCase } from '../../../application/auth/RegisterUseCase.js';
import type { LoginUseCase } from '../../../application/auth/LoginUseCase.js';
import { invalidRequest, ok, sendDomainError } from '../reply.js';
import { formatIssues, loginBodySchema, registerBodySchema } from '../validation.js';

interface AuthRoutesDeps {
  registerUseCase: RegisterUseCase;
  loginUseCase: LoginUseCase;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesDeps> = async (fastify, opts) => {
  /**
   * POST /api/v1/auth/register
   * Body: { tenant_name, email, password }
   * Returns: { tenant_id, user_id, token }
   */
  fastify.post<{
    Body: { tenant_name: string; email: string; password: string };
  }>('/register', async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      invalidRequest(reply, formatIssues(parsed.error));
      return;
    }

    try {
      const result = await opts.registerUseCase.execute({
        tenantName: parsed.data.tenant_name,
        email: parsed.data.email,
        password: parsed.data.password,
      });

      const token = fastify.jwt.sign(
        { sub: result.userId, tid: result.tenantId, role: 'owner' },
        { expiresIn: '12h' },
      );

      ok(reply, { tenant_id: result.tenantId, user_id: result.userId, token }, 201);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /**
   * POST /api/v1/auth/login
   * Body: { email, password, tenant_slug }
   * Returns: { token, tenant_id, expires_at }
   */
  fastify.post<{
    Body: { email: string; password: string; tenant_slug: string };
  }>('/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      invalidRequest(reply, formatIssues(parsed.error));
      return;
    }

    try {
      const result = await opts.loginUseCase.execute({
        email: parsed.data.email,
        password: parsed.data.password,
        tenantSlug: parsed.data.tenant_slug,
      });

      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
      const token = fastify.jwt.sign(
        { sub: result.userId, tid: result.tenantId, role: result.role },
        { expiresIn: '12h' },
      );

      ok(reply, { token, tenant_id: result.tenantId, expires_at: expiresAt });
    } catch (err) {
      sendDomainError(reply, err);
    }
  });
};
