import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * AsyncLocalStorage that holds the current tenant_id for RLS enforcement.
 * Set by authPlugin.authenticate after the JWT is verified (and by
 * withTenantContext for the two flows that run before a tenant is known);
 * read by the Prisma client extension.
 */
export const tenantContext = new AsyncLocalStorage<string>();

export function getCurrentTenantId(): string | undefined {
  return tenantContext.getStore();
}
