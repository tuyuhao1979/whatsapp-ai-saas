import type { PrismaClient } from '@prisma/client';
import type { ITenantRepo, CreateTenantInput, UpdateTenantInput } from '../../domain/ports/ITenantRepo.js';
import type { Tenant } from '../../domain/models/Tenant.js';

function mapTenant(row: {
  id: string;
  name: string;
  slug: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  accessToken: string | null;
  plan: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    accessToken: row.accessToken,
    plan: row.plan as Tenant['plan'],
    status: row.status as Tenant['status'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaTenantRepo implements ITenantRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { id } });
    return row ? mapTenant(row) : null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { slug } });
    return row ? mapTenant(row) : null;
  }

  async findByPhoneNumberId(phoneNumberId: string): Promise<Tenant | null> {
    const row = await this.prisma.tenant.findUnique({ where: { phoneNumberId } });
    return row ? mapTenant(row) : null;
  }

  async create(input: CreateTenantInput): Promise<Tenant> {
    const row = await this.prisma.tenant.create({
      data: {
        name: input.name,
        slug: input.slug,
      },
    });
    return mapTenant(row);
  }

  async update(id: string, input: UpdateTenantInput): Promise<Tenant> {
    const row = await this.prisma.tenant.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.wabaId !== undefined && { wabaId: input.wabaId }),
        ...(input.phoneNumberId !== undefined && { phoneNumberId: input.phoneNumberId }),
        ...(input.accessToken !== undefined && { accessToken: input.accessToken }),
        updatedAt: new Date(),
      },
    });
    return mapTenant(row);
  }
}
