import argon2 from 'argon2';
import { withTenantContext } from '../../infrastructure/prisma/PrismaClient.js';
import type { ITenantRepo } from '../../domain/ports/ITenantRepo.js';
import type { IUserRepo } from '../../domain/ports/IUserRepo.js';
import { UnauthorizedError } from '../../domain/errors.js';

export interface LoginInput {
  email: string;
  password: string;
  tenantSlug: string;
}

export interface LoginOutput {
  tenantId: string;
  userId: string;
  role: string;
}

export class LoginUseCase {
  constructor(
    private readonly tenantRepo: ITenantRepo,
    private readonly userRepo: IUserRepo,
  ) {}

  async execute(input: LoginInput): Promise<LoginOutput> {
    const tenant = await this.tenantRepo.findBySlug(input.tenantSlug);
    if (!tenant) {
      // Return generic error to prevent slug enumeration
      throw new UnauthorizedError('Invalid credentials');
    }

    // `users` is a tenant-scoped table under FORCE ROW LEVEL SECURITY, and an
    // unauthenticated request has no tenant context, so the lookup must run
    // inside an explicitly established context or RLS denies every row and
    // login can never succeed (audit finding B4).
    const user = await withTenantContext(tenant.id, () =>
      this.userRepo.findByEmailAndTenant(input.email, tenant.id),
    );
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const valid = await argon2.verify(user.passwordHash, input.password);
    if (!valid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    return { tenantId: tenant.id, userId: user.id, role: user.role };
  }
}
