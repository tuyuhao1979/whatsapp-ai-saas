import type { Tenant } from '../models/Tenant.js';

export interface CreateTenantInput {
  name: string;
  slug: string;
}

export interface UpdateTenantInput {
  name?: string;
  wabaId?: string;
  phoneNumberId?: string;
  accessToken?: string | null;
}

export interface ITenantRepo {
  findById(id: string): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  /**
   * Look up the tenant that has bound a given Meta phone number id.
   *
   * `tenants` is the one tenant-scoped-by-convention table without RLS, and
   * `phone_number_id` is globally UNIQUE, so this lookup is safe and is what
   * lets onboarding reject a number another tenant already claimed.
   */
  findByPhoneNumberId(phoneNumberId: string): Promise<Tenant | null>;
  create(input: CreateTenantInput): Promise<Tenant>;
  update(id: string, input: UpdateTenantInput): Promise<Tenant>;
}
