import { z } from 'zod';

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_MIGRATION_URL: z.string().min(1, 'DATABASE_MIGRATION_URL is required'),

  // Redis
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // Meta onboarding (Embedded Signup / OAuth code exchange / webhook subscription)
  // META_APP_ID and META_CONFIG_ID are only required to offer Embedded Signup;
  // the manual connect path keeps working without them.
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_CONFIG_ID: z.string().default(''),
  META_API_BASE: z
    .string()
    .url('META_API_BASE must be a valid URL')
    .default('https://graph.facebook.com/v21.0'),
  META_EMBEDDED_SIGNUP_REDIRECT_URI: z.string().default(''),
  OAUTH_STATE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  META_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Reject onboarding unless the token provably manages the requested WABA.
  // Disabling this re-opens the phone-number hijack vector (audit finding H2).
  META_REQUIRE_OWNERSHIP_PROOF: z
    .string()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // Encryption
  MASTER_KEY: z
    .string()
    .min(32, 'MASTER_KEY must be at least 32 bytes (hex-encoded or raw)')
    .refine(
      (v) => Buffer.from(v, 'utf8').length >= 32,
      'MASTER_KEY must encode to at least 32 bytes',
    ),

  // MinIO / S3
  S3_ENDPOINT: z.string().min(1, 'S3_ENDPOINT is required'),
  S3_PORT: z.coerce.number().int().positive().default(9000),
  S3_USE_SSL: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY is required'),
  S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY is required'),
  S3_BUCKET_KB: z.string().min(1, 'S3_BUCKET_KB is required'),

  // Flow Engine
  FLOW_ENGINE_ADMIN_URL: z.string().url('FLOW_ENGINE_ADMIN_URL must be a valid URL'),
  INTERNAL_API_TOKEN: z.string().min(1, 'INTERNAL_API_TOKEN is required'),

  // KB limits
  KB_MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),
  KB_MAX_DOCUMENTS_PER_TENANT: z.coerce.number().int().positive().default(100),

  // Dry-run timeout
  DRY_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration error:\n${formatted}`);
  }
  return result.data;
}
