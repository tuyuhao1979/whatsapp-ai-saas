import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifySensible from '@fastify/sensible';
import fastifyMultipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
import { getPrismaClient } from './infrastructure/prisma/PrismaClient.js';
import { PrismaTenantRepo } from './infrastructure/prisma/PrismaTenantRepo.js';
import { PrismaUserRepo } from './infrastructure/prisma/PrismaUserRepo.js';
import { PrismaFlowRepo } from './infrastructure/prisma/PrismaFlowRepo.js';
import { PrismaKbDocumentRepo } from './infrastructure/prisma/PrismaKbDocumentRepo.js';
import { PrismaConvLogRepo } from './infrastructure/prisma/PrismaConvLogRepo.js';
import { MinioStorageAdapter } from './infrastructure/storage/MinioStorageAdapter.js';
import { RedisIndexingQueue } from './infrastructure/redis/RedisIndexingQueue.js';
import { FlowEngineHttpClient } from './infrastructure/flowengine/FlowEngineHttpClient.js';
import { MetaGraphClient } from './infrastructure/meta/MetaGraphClient.js';
import { RedisOAuthStateStore } from './infrastructure/redis/RedisOAuthStateStore.js';
import { RegisterUseCase } from './application/auth/RegisterUseCase.js';
import { LoginUseCase } from './application/auth/LoginUseCase.js';
import { GetTenantUseCase } from './application/tenant/GetTenantUseCase.js';
import { UpdateTenantUseCase } from './application/tenant/UpdateTenantUseCase.js';
import { ConnectWhatsAppUseCase } from './application/tenant/ConnectWhatsAppUseCase.js';
import { StartMetaOnboardingUseCase } from './application/tenant/StartMetaOnboardingUseCase.js';
import { CompleteMetaOnboardingUseCase } from './application/tenant/CompleteMetaOnboardingUseCase.js';
import { CheckMetaConnectionUseCase } from './application/tenant/CheckMetaConnectionUseCase.js';
import { CreateFlowUseCase } from './application/flows/CreateFlowUseCase.js';
import { UpdateFlowUseCase } from './application/flows/UpdateFlowUseCase.js';
import { ActivateFlowUseCase } from './application/flows/ActivateFlowUseCase.js';
import { DeleteFlowUseCase } from './application/flows/DeleteFlowUseCase.js';
import { GetFlowUseCase, ListFlowsUseCase } from './application/flows/GetFlowUseCase.js';
import { UploadDocumentUseCase } from './application/kb/UploadDocumentUseCase.js';
import { ListDocumentsUseCase } from './application/kb/ListDocumentsUseCase.js';
import { DeleteDocumentUseCase } from './application/kb/DeleteDocumentUseCase.js';
import { ListConversationsUseCase } from './application/conversations/ListConversationsUseCase.js';
import { DryRunUseCase } from './application/dryrun/DryRunUseCase.js';
import { authPlugin } from './interfaces/http/plugins/authPlugin.js';
import { authorizePlugin } from './interfaces/http/plugins/authorizePlugin.js';
import { authRoutes } from './interfaces/http/routes/auth.routes.js';
import { tenantRoutes } from './interfaces/http/routes/tenant.routes.js';
import { metaRoutes } from './interfaces/http/routes/meta.routes.js';
import { flowsRoutes } from './interfaces/http/routes/flows.routes.js';
import { kbRoutes } from './interfaces/http/routes/kb.routes.js';
import { conversationsRoutes } from './interfaces/http/routes/conversations.routes.js';
import { dryrunRoutes } from './interfaces/http/routes/dryrun.routes.js';
import { formatIssues, nulPathIn } from './interfaces/http/validation.js';
import { invalidRequest } from './interfaces/http/reply.js';
import { masterKeysFromConfig } from './application/tenant/encryption.js';
import type { FastifyInstance } from 'fastify';

export async function buildApp(): Promise<FastifyInstance> {
  const config = loadConfig();

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' && {
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
    },
  });

  await app.register(fastifySensible);
  await app.register(fastifyMultipart, {
    limits: { fileSize: config.KB_MAX_FILE_SIZE_MB * 1024 * 1024 },
  });

  // Auth plugin (registers JWT)
  await app.register(authPlugin, { config });

  // RBAC plugin (consumes the role claim the auth plugin binds)
  await app.register(authorizePlugin);

  // ---------------------------------------------------------------------------
  // Infrastructure adapters
  // ---------------------------------------------------------------------------
  const prisma = getPrismaClient();
  const redis = new Redis(config.REDIS_URL, { lazyConnect: false });

  const tenantRepo = new PrismaTenantRepo(prisma);
  const userRepo = new PrismaUserRepo(prisma);
  const flowRepo = new PrismaFlowRepo(prisma);
  const kbRepo = new PrismaKbDocumentRepo(prisma);
  const convLogRepo = new PrismaConvLogRepo(prisma);

  const storage = new MinioStorageAdapter({
    endPoint: config.S3_ENDPOINT,
    port: config.S3_PORT,
    useSSL: config.S3_USE_SSL,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET_KB,
  });

  const queue = new RedisIndexingQueue(redis);

  const flowEngineClient = new FlowEngineHttpClient(
    config.FLOW_ENGINE_ADMIN_URL,
    config.INTERNAL_API_TOKEN,
    config.DRY_RUN_TIMEOUT_MS,
  );

  // Meta Graph API adapter for onboarding / ownership verification.
  const metaClient = new MetaGraphClient({
    baseUrl: config.META_API_BASE,
    appId: config.META_APP_ID,
    appSecret: config.META_APP_SECRET,
    timeoutMs: config.META_HTTP_TIMEOUT_MS,
  });

  const oauthStateStore = new RedisOAuthStateStore(redis, config.OAUTH_STATE_TTL_SECONDS);

  const embeddedSignupAvailable = Boolean(config.META_APP_ID && config.META_CONFIG_ID);

  // Key set for the WhatsApp access token at rest (H1 + H6). Built once, so a
  // rotation touches only the environment.
  const masterKeys = masterKeysFromConfig({
    masterKey: config.MASTER_KEY,
    masterKeyId: config.MASTER_KEY_ID,
    previousMasterKey: config.MASTER_KEY_PREVIOUS,
    previousMasterKeyId: config.MASTER_KEY_PREVIOUS_ID,
  });

  // ---------------------------------------------------------------------------
  // Use cases
  // ---------------------------------------------------------------------------
  const registerUseCase = new RegisterUseCase(tenantRepo, userRepo);
  const loginUseCase = new LoginUseCase(tenantRepo, userRepo);
  const getTenantUseCase = new GetTenantUseCase(tenantRepo);
  const updateTenantUseCase = new UpdateTenantUseCase(tenantRepo);
  const connectWhatsAppUseCase = new ConnectWhatsAppUseCase(tenantRepo, metaClient, {
    masterKeys,
    requireOwnershipProof: config.META_REQUIRE_OWNERSHIP_PROOF,
    expectedAppId: config.META_APP_ID || null,
  });
  const startMetaOnboardingUseCase = new StartMetaOnboardingUseCase(oauthStateStore, {
    appId: config.META_APP_ID,
    configId: config.META_CONFIG_ID,
    redirectUri: config.META_EMBEDDED_SIGNUP_REDIRECT_URI,
    stateTtlSeconds: config.OAUTH_STATE_TTL_SECONDS,
  });
  const completeMetaOnboardingUseCase = new CompleteMetaOnboardingUseCase(
    oauthStateStore,
    metaClient,
    connectWhatsAppUseCase,
  );
  const checkMetaConnectionUseCase = new CheckMetaConnectionUseCase(
    tenantRepo,
    metaClient,
    masterKeys,
    config.META_APP_ID,
  );
  const createFlowUseCase = new CreateFlowUseCase(flowRepo, flowEngineClient);
  const updateFlowUseCase = new UpdateFlowUseCase(flowRepo, flowEngineClient);
  const activateFlowUseCase = new ActivateFlowUseCase(flowRepo, flowEngineClient);
  const deleteFlowUseCase = new DeleteFlowUseCase(flowRepo, flowEngineClient);
  const getFlowUseCase = new GetFlowUseCase(flowRepo);
  const listFlowsUseCase = new ListFlowsUseCase(flowRepo);
  const uploadDocumentUseCase = new UploadDocumentUseCase(
    kbRepo,
    storage,
    queue,
    config.KB_MAX_FILE_SIZE_MB,
    config.KB_MAX_DOCUMENTS_PER_TENANT,
  );
  const listDocumentsUseCase = new ListDocumentsUseCase(kbRepo);
  const deleteDocumentUseCase = new DeleteDocumentUseCase(kbRepo, storage, queue);
  const listConversationsUseCase = new ListConversationsUseCase(convLogRepo);
  const dryRunUseCase = new DryRunUseCase(flowEngineClient);

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  // Registered before the routes so it applies to all of them: a NUL character
  // in any string the caller sends is a bad request, not a server fault.
  // PostgreSQL rejects NUL in both `text` and `jsonb`, so without this the
  // failure surfaced as a 500 from deep inside the query layer (Schemathesis
  // hit it in `tenant_slug` and nested inside a flow's `trigger`).
  app.addHook('preValidation', async (request, reply) => {
    const offending =
      nulPathIn('body', request.body) ??
      nulPathIn('query', request.query) ??
      nulPathIn('params', request.params);

    if (offending !== null) {
      return invalidRequest(reply, [`${offending}: NUL (U+0000) is not allowed`]);
    }
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes, {
        prefix: '/auth',
        registerUseCase,
        loginUseCase,
      });

      await api.register(tenantRoutes, {
        prefix: '/tenant',
        getTenantUseCase,
        updateTenantUseCase,
        connectWhatsAppUseCase,
      });

      await api.register(metaRoutes, {
        prefix: '/meta',
        startMetaOnboardingUseCase,
        completeMetaOnboardingUseCase,
        checkMetaConnectionUseCase,
        embeddedSignupAvailable,
      });

      await api.register(flowsRoutes, {
        prefix: '/flows',
        createFlowUseCase,
        updateFlowUseCase,
        activateFlowUseCase,
        deleteFlowUseCase,
        getFlowUseCase,
        listFlowsUseCase,
      });

      await api.register(kbRoutes, {
        prefix: '/kb',
        uploadDocumentUseCase,
        listDocumentsUseCase,
        deleteDocumentUseCase,
      });

      await api.register(conversationsRoutes, {
        prefix: '/conversations',
        listConversationsUseCase,
      });

      await api.register(dryrunRoutes, {
        prefix: '/dry-run',
        dryRunUseCase,
      });

      // Health checks
      api.get('/health', () => ({ status: 'ok' }));
      api.get('/healthz', () => ({ status: 'ok' }));
      api.get('/readyz', async (_req, reply) => {
        try {
          await redis.ping();
          return reply.status(200).send({ status: 'ok' });
        } catch {
          return reply.status(503).send({ status: 'unavailable' });
        }
      });
    },
    { prefix: '/api/v1' },
  );

  // Global error handler
  //
  // Anything still unhandled by a route lands here. Two classes of error must
  // not become a 500:
  //
  //  1. Fastify's own client errors for malformed requests - unparsable JSON,
  //     an empty body carrying `Content-Type: application/json`, an unsupported
  //     media type, an unsupported method. They carry a 4xx `statusCode`, and
  //     answering 500 blames the server for the caller's mistake. Schemathesis
  //     reported every one of these as a server error against the isolated
  //     stack before this branch existed.
  //  2. A Zod issue that escaped a route's own `safeParse`.
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 0;

    if (statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({
        data: null,
        error: {
          code:
            statusCode === 415
              ? 'UNSUPPORTED_MEDIA_TYPE'
              : statusCode === 405
                ? 'METHOD_NOT_ALLOWED'
                : 'INVALID_REQUEST',
          message: error.message,
        },
        meta: { request_id: randomUUID() },
      });
      return;
    }

    if (error instanceof ZodError) {
      void reply.status(400).send({
        data: null,
        error: {
          code: 'INVALID_REQUEST',
          message: 'Request validation failed',
          details: formatIssues(error),
        },
        meta: { request_id: randomUUID() },
      });
      return;
    }

    app.log.error({ err: error }, 'Unhandled error');
    void reply.status(500).send({
      data: null,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      meta: { request_id: randomUUID() },
    });
  });

  return app;
}

// Entrypoint
async function start(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    app.log.info(`Tenant API listening on port ${config.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// An explicit call rather than top-level await: tsconfig.test.json compiles to
// CommonJS for jest, so this file belongs to a program where top-level await is
// TS1378. Importing the module still boots the server, exactly as before.
void start();
