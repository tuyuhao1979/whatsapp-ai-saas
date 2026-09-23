import argon2 from 'argon2';
import { withTenantContext } from '../../infrastructure/prisma/PrismaClient.js';
import type { ITenantRepo } from '../../domain/ports/ITenantRepo.js';
import type { IUserRepo } from '../../domain/ports/IUserRepo.js';
import { ConflictError, ValidationError } from '../../domain/errors.js';

export interface RegisterInput {
  tenantName: string;
  email: string;
  password: string;
}

export interface RegisterOutput {
  tenantId: string;
  userId: string;
}

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

export class RegisterUseCase {
  constructor(
    private readonly tenantRepo: ITenantRepo,
    private readonly userRepo: IUserRepo,
  ) {}

  async execute(input: RegisterInput): Promise<RegisterOutput> {
    if (!input.email.includes('@')) {
      throw new ValidationError('Invalid email address');
    }
    if (input.password.length < 12) {
      throw new ValidationError('Password must be at least 12 characters');
    }
    if (!input.tenantName.trim()) {
      throw new ValidationError('Tenant name is required');
    }

    const slug = generateSlug(input.tenantName);
    const existingTenant = await this.tenantRepo.findBySlug(slug);
    if (existingTenant) {
      throw new ConflictError(`Tenant slug '${slug}' is already taken`);
    }

    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
    });

    const tenant = await this.tenantRepo.create({ name: input.tenantName, slug });

    // `users` is under FORCE ROW LEVEL SECURITY and this request has no tenant
    // context yet, so the INSERT must run inside the freshly created tenant's
    // context or the policy rejects the new row (audit finding B4).
    const user = await withTenantContext(tenant.id, () =>
      this.userRepo.create({
        tenantId: tenant.id,
        email: input.email,
        passwordHash,
        role: 'owner',
      }),
    );

    return { tenantId: tenant.id, userId: user.id };
  }
}
