import argon2 from 'argon2';
import { LoginUseCase } from '../../src/application/auth/LoginUseCase.js';
import { UnauthorizedError } from '../../src/domain/errors.js';
import type { ITenantRepo } from '../../src/domain/ports/ITenantRepo.js';
import type { IUserRepo } from '../../src/domain/ports/IUserRepo.js';
import type { Tenant } from '../../src/domain/models/Tenant.js';
import type { User } from '../../src/domain/models/User.js';

const TENANT: Tenant = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Acme',
  slug: 'acme',
  wabaId: null,
  phoneNumberId: null,
  accessToken: null,
  plan: 'free',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function makeUser(password: string): Promise<User> {
  return {
    id: 'user-uuid',
    tenantId: '11111111-1111-4111-8111-111111111111',
    email: 'owner@acme.com',
    passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
    role: 'owner',
    createdAt: new Date(),
  };
}

describe('LoginUseCase', () => {
  it('returns credentials on valid email + password + slug', async () => {
    const user = await makeUser('correctpassword');

    const tenantRepo: ITenantRepo = {
      findById: jest.fn(),
      findBySlug: jest.fn().mockResolvedValue(TENANT),
      findTenantIdByPhoneNumberId: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    const userRepo: IUserRepo = {
      findById: jest.fn(),
      findByEmailAndTenant: jest.fn().mockResolvedValue(user),
      create: jest.fn(),
    };

    const useCase = new LoginUseCase(tenantRepo, userRepo);
    const result = await useCase.execute({
      email: 'owner@acme.com',
      password: 'correctpassword',
      tenantSlug: 'acme',
    });

    expect(result).toMatchObject({
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-uuid',
      role: 'owner',
    });
  });

  it('throws UnauthorizedError for unknown tenant slug', async () => {
    const tenantRepo: ITenantRepo = {
      findById: jest.fn(),
      findBySlug: jest.fn().mockResolvedValue(null),
      findTenantIdByPhoneNumberId: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    const useCase = new LoginUseCase(tenantRepo, {
      findById: jest.fn(),
      findByEmailAndTenant: jest.fn(),
      create: jest.fn(),
    });

    await expect(
      useCase.execute({ email: 'a@b.com', password: 'pass', tenantSlug: 'unknown' }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it('throws UnauthorizedError for unknown email', async () => {
    const tenantRepo: ITenantRepo = {
      findById: jest.fn(),
      findBySlug: jest.fn().mockResolvedValue(TENANT),
      findTenantIdByPhoneNumberId: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    const userRepo: IUserRepo = {
      findById: jest.fn(),
      findByEmailAndTenant: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    };

    const useCase = new LoginUseCase(tenantRepo, userRepo);
    await expect(
      useCase.execute({ email: 'nobody@acme.com', password: 'pass', tenantSlug: 'acme' }),
    ).rejects.toThrow(UnauthorizedError);
  });

  it('throws UnauthorizedError for wrong password', async () => {
    const user = await makeUser('correctpassword');

    const tenantRepo: ITenantRepo = {
      findById: jest.fn(),
      findBySlug: jest.fn().mockResolvedValue(TENANT),
      findTenantIdByPhoneNumberId: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    };

    const userRepo: IUserRepo = {
      findById: jest.fn(),
      findByEmailAndTenant: jest.fn().mockResolvedValue(user),
      create: jest.fn(),
    };

    const useCase = new LoginUseCase(tenantRepo, userRepo);
    await expect(
      useCase.execute({ email: 'owner@acme.com', password: 'wrongpassword', tenantSlug: 'acme' }),
    ).rejects.toThrow(UnauthorizedError);
  });
});
