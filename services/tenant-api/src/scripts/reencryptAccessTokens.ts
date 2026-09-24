import { loadConfig } from '../config.js';
import { getPrismaClient, withTenantContext } from '../infrastructure/prisma/PrismaClient.js';
import {
  decryptAccessToken,
  encryptAccessToken,
  isEncryptedTokenV2,
  masterKeysFromConfig,
} from '../application/tenant/encryption.js';

// ---------------------------------------------------------------------------
// Re-encrypt tenants.access_token onto the current MASTER_KEY (audit H6).
// ---------------------------------------------------------------------------
// Run inside the service container, where the environment is complete. The
// runtime image ships the compiled build, not the sources, so invoke dist/:
//
//   docker compose exec tenant-api node dist/scripts/reencryptAccessTokens.js --dry-run
//   docker compose exec tenant-api node dist/scripts/reencryptAccessTokens.js
//
// (During development outside Docker: pnpm exec tsx src/scripts/reencryptAccessTokens.ts)
//
// Rotation procedure:
//   1. set MASTER_KEY=<new> MASTER_KEY_ID=k2 MASTER_KEY_PREVIOUS=<old> MASTER_KEY_PREVIOUS_ID=k1
//      (the previous key keeps existing rows readable; new writes already use k2)
//   2. deploy, then run this script to rewrite every row onto k2
//   3. drop MASTER_KEY_PREVIOUS / MASTER_KEY_PREVIOUS_ID and deploy again
//
// The script connects with the ordinary runtime role (DATABASE_URL) and uses
// the same RLS middleware as the service: it enumerates rows through the
// SECURITY DEFINER function `list_bound_tenants()` (which returns identifiers
// only) and then reads and rewrites each row under that tenant's own
// `app.tenant_id` context. No elevated database role is required, and the
// policy keeps applying to every access it makes.
//
// It is idempotent: rows already on the current key are left untouched.
// ---------------------------------------------------------------------------

interface BoundTenant {
  tenant_id: string;
  phone_number_id: string;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const config = loadConfig();
  const keys = masterKeysFromConfig({
    masterKey: config.MASTER_KEY,
    masterKeyId: config.MASTER_KEY_ID,
    previousMasterKey: config.MASTER_KEY_PREVIOUS,
    previousMasterKeyId: config.MASTER_KEY_PREVIOUS_ID,
  });

  const currentPrefix = `v2.${keys.current.id}.`;
  const prisma = getPrismaClient();

  let migrated = 0;
  let alreadyCurrent = 0;
  const failures: string[] = [];

  try {
    const rows = await prisma.$queryRaw<BoundTenant[]>`
      SELECT tenant_id, phone_number_id FROM list_bound_tenants()
    `;

    console.log(
      `${dryRun ? '[dry-run] ' : ''}${rows.length} tenant(s) with a stored access token; ` +
        `current key id '${keys.current.id}'`,
    );

    for (const bound of rows) {
      const tenantId = bound.tenant_id;
      const phoneNumberId = bound.phone_number_id;
      const label = `tenant ${tenantId}`;

      // Every read and write happens under this tenant's own RLS context, so
      // the policy applies to the script exactly as it does to a request.
      await withTenantContext(tenantId, async () => {
        const row = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { accessToken: true },
        });
        const envelope = row?.accessToken;

        if (!envelope) return;
        if (envelope.startsWith(currentPrefix)) {
          alreadyCurrent += 1;
          return;
        }

        const format = isEncryptedTokenV2(envelope) ? 'v2 (older key id)' : 'v1 (legacy)';
        try {
          const plaintext = decryptAccessToken(envelope, keys, { tenantId, phoneNumberId });
          const reencrypted = encryptAccessToken(plaintext, keys, { tenantId, phoneNumberId });

          if (dryRun) {
            console.log(`  would re-encrypt ${label} (${format})`);
          } else {
            await prisma.tenant.update({
              where: { id: tenantId },
              data: { accessToken: reencrypted },
            });
            console.log(`  re-encrypted ${label} (${format})`);
          }
          migrated += 1;
        } catch (err) {
          failures.push(
            `${label} (${format}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\n${dryRun ? 'Would migrate' : 'Migrated'} ${migrated}, already on the current key ${alreadyCurrent}, ` +
      `failed ${failures.length}`,
  );
  for (const failure of failures) console.error(`  FAILED ${failure}`);

  if (failures.length > 0) {
    // Never silently leave rows unreadable: a rotation without MASTER_KEY_PREVIOUS
    // set would strand them.
    console.error('\nRe-run with MASTER_KEY_PREVIOUS set to the key those rows used.');
    process.exit(1);
  }
}

void main();
