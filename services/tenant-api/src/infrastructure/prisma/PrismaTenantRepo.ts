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

  /**
   * Login-time lookup. Uses the SECURITY DEFINER function from migration 007:
   * there is no tenant context before the slug is resolved, and `tenants` is
   * under FORCE ROW LEVEL SECURITY, so a plain findUnique would return no row.
   * The function exposes id/slug/status only.
   *
   * The returned Tenant carries nulls for everything the function does not
   * return; callers must use it for identity, not for credentials.
   */
  async findBySlug(slug: string): Promise<Tenant | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ tenant_id: string; tenant_slug: string; tenant_status: string }>
    >`SELECT tenant_id, tenant_slug, tenant_status FROM lookup_tenant_by_slug(${slug})`;

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.tenant_id,
      name: '',
      slug: row.tenant_slug,
      wabaId: null,
      phoneNumberId: null,
      accessToken: null,
      plan: 'free',
      status: row.tenant_status as Tenant['status'],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  /**
   * Resolve the owner of a phone number through the SECURITY DEFINER function,
   * which is the only sanctioned cross-tenant read of `tenants`.
   */
  async findTenantIdByPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ tenant_id: string | null }>
    >`SELECT tenant_id_for_phone(${phoneNumberId}) AS tenant_id`;
    return rows[0]?.tenant_id ?? null;
  }

  async create(input: CreateTenantInput): Promise<Tenant> {
    const row = await this.prisma.tenant.create({
      data: {
        id: input.id,
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
