import { RegisterUseCase } from '../../src/application/auth/RegisterUseCase.js';
import { ConflictError, ValidationError } from '../../src/domain/errors.js';
import type { ITenantRepo } from '../../src/domain/ports/ITenantRepo.js';
import type { IUserRepo } from '../../src/domain/ports/IUserRepo.js';
import type { Tenant } from '../../src/domain/models/Tenant.js';
import type { User } from '../../src/domain/models/User.js';

function makeFakeTenantRepo(overrides: Partial<ITenantRepo> = {}): ITenantRepo {
  return {
    findById: jest.fn().mockResolvedValue(null),
    findBySlug: jest.fn().mockResolvedValue(null),
    findByPhoneNumberId: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({
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
    } satisfies Tenant),
    update: jest.fn(),
    ...overrides,
  };
}

function makeFakeUserRepo(overrides: Partial<IUserRepo> = {}): IUserRepo {
  return {
    findById: jest.fn().mockResolvedValue(null),
    findByEmailAndTenant: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({
      id: 'user-uuid',
      tenantId: '11111111-1111-4111-8111-111111111111',
      email: 'owner@acme.com',
      passwordHash: 'hashed',
      role: 'owner',
      createdAt: new Date(),
    } satisfies User),
    ...overrides,
  };
}

describe('RegisterUseCase', () => {
  it('creates a tenant and owner user successfully', async () => {
    const tenantRepo = makeFakeTenantRepo();
    const userRepo = makeFakeUserRepo();
    const useCase = new RegisterUseCase(tenantRepo, userRepo);

    const result = await useCase.execute({
      tenantName: 'Acme Corp',
      email: 'owner@acme.com',
      password: 'securepassword123',
    });

    expect(result).toMatchObject({
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: 'user-uuid',
    });
    expect(tenantRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Acme Corp', slug: 'acme-corp' }),
    );
    expect(userRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'owner', email: 'owner@acme.com' }),
    );
  });

  it('throws ConflictError when slug is already taken', async () => {
    const tenantRepo = makeFakeTenantRepo({
      findBySlug: jest.fn().mockResolvedValue({ id: 'existing' }),
    });
    const useCase = new RegisterUseCase(tenantRepo, makeFakeUserRepo());

    // NOTE: upstream this test used an 11-character password, so the
    // "at least 12 characters" guard fired first and the assertion below never
    // exercised the slug-conflict branch. The suite could not load at all
    // before (see jest.config.js), which is why the staleness went unnoticed.
    await expect(
      useCase.execute({ tenantName: 'Acme', email: 'a@b.com', password: 'password1234' }),
    ).rejects.toThrow(ConflictError);
  });

  it('throws ValidationError for invalid email', async () => {
    const useCase = new RegisterUseCase(makeFakeTenantRepo(), makeFakeUserRepo());

    await expect(
      useCase.execute({ tenantName: 'Acme', email: 'notanemail', password: 'password123' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for short password', async () => {
    const useCase = new RegisterUseCase(makeFakeTenantRepo(), makeFakeUserRepo());

    await expect(
      useCase.execute({ tenantName: 'Acme', email: 'a@b.com', password: '1234567' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for empty tenant name', async () => {
    const useCase = new RegisterUseCase(makeFakeTenantRepo(), makeFakeUserRepo());

    await expect(
      useCase.execute({ tenantName: '  ', email: 'a@b.com', password: 'password123' }),
    ).rejects.toThrow(ValidationError);
  });

  it('hashes the password (does not store plaintext)', async () => {
    const userRepo = makeFakeUserRepo();
    const useCase = new RegisterUseCase(makeFakeTenantRepo(), userRepo);

    await useCase.execute({
      tenantName: 'Test',
      email: 'a@b.com',
      password: 'plaintext-password',
    });

    const createCall = (userRepo.create as jest.Mock).mock.calls[0][0];
    expect(createCall.passwordHash).not.toBe('plaintext-password');
    expect(createCall.passwordHash).toMatch(/^\$argon2/);
  });
});
