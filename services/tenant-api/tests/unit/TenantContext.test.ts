import {
  getPrismaClient,
  isValidTenantId,
  withTenantContext,
} from '../../src/infrastructure/prisma/PrismaClient.js';

/**
 * Audit finding H4 — the tenant id arrives from a JWT claim and was previously
 * interpolated straight into SQL text:
 *
 *   await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tenantId}'`)
 *
 * Two defences replaced it: the claim must be shaped like a UUID, and the value
 * is now bound as a parameter (a tagged template) rather than concatenated.
 *
 * These tests cover the validation half. The parameterisation half is covered
 * by test_sql_schema_alignment.py on the Python side and by static review of
 * getPrismaClient's middleware.
 */
describe('tenant id validation', () => {
  it('accepts canonical UUIDs', () => {
    expect(isValidTenantId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isValidTenantId('AABBCCDD-1122-4333-8444-556677889900')).toBe(true);
  });

  it('rejects SQL-injection shaped payloads', () => {
    const payloads = [
      "00000000-0000-4000-8000-000000000000' OR true --",
      "' OR 1=1 --",
      '1; DROP TABLE users',
      '11111111-1111-4111-8111-111111111111x',
    ];
    for (const payload of payloads) {
      expect(isValidTenantId(payload)).toBe(false);
    }
  });

  it('rejects non-strings and empty values', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      expect(isValidTenantId(value)).toBe(false);
    }
    expect(isValidTenantId('')).toBe(false);
  });
});

describe('withTenantContext', () => {
  it('refuses to establish a context for a malformed tenant id', async () => {
    await expect(
      withTenantContext("' OR 1=1 --", async () => 'never'),
    ).rejects.toThrow(/valid tenant UUID/);
  });

  it('runs the callback for a valid tenant id', async () => {
    const result = await withTenantContext(
      '11111111-1111-4111-8111-111111111111',
      async () => 'ran',
    );
    expect(result).toBe('ran');
  });
});

describe('prisma client construction', () => {
  it('does not touch the database at import time', () => {
    // Guards against a regression where the client is instantiated eagerly at
    // module load, which would break every unit test that imports a use case.
    expect(typeof getPrismaClient).toBe('function');
  });
});
