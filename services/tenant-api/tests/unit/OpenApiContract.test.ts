import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { authPlugin } from '../../src/interfaces/http/plugins/authPlugin.js';
import { authorizePlugin } from '../../src/interfaces/http/plugins/authorizePlugin.js';
import { authRoutes } from '../../src/interfaces/http/routes/auth.routes.js';
import { tenantRoutes } from '../../src/interfaces/http/routes/tenant.routes.js';
import { metaRoutes } from '../../src/interfaces/http/routes/meta.routes.js';
import { flowsRoutes } from '../../src/interfaces/http/routes/flows.routes.js';
import { kbRoutes } from '../../src/interfaces/http/routes/kb.routes.js';
import { conversationsRoutes } from '../../src/interfaces/http/routes/conversations.routes.js';
import { dryrunRoutes } from '../../src/interfaces/http/routes/dryrun.routes.js';

/**
 * The OpenAPI document is hand-maintained (the Fastify routes declare almost no
 * JSON Schema, so a generated document would be nearly empty). This test is what
 * keeps it honest: Schemathesis fuzzing a stale contract is worse than no
 * fuzzing, because it produces false confidence.
 *
 * It asserts both directions:
 *   - every documented path+method exists in the running route table
 *   - every registered route is documented
 */

const SPEC_PATH = resolve(__dirname, '../../../../infra/contracts/openapi-tenant-api.json');

const API_PREFIX = '/api/v1';

interface Spec {
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
}

const spec = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Spec;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Fastify `/api/v1/flows/:id` -> spec `flows/{id}`. */
function toSpecPath(fastifyUrl: string): string {
  const withoutPrefix = fastifyUrl.startsWith(API_PREFIX)
    ? fastifyUrl.slice(API_PREFIX.length)
    : fastifyUrl;
  const normalised = withoutPrefix.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  return normalised === '' ? '/' : normalised;
}

async function collectRegisteredRoutes(): Promise<Set<string>> {
  const app = Fastify();
  const seen = new Set<string>();

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      seen.add(`${method.toUpperCase()} ${toSpecPath(route.url)}`);
    }
  });

  await app.register(authPlugin, { config: { JWT_SECRET: 'x'.repeat(40) } as never });
  await app.register(authorizePlugin);

  await app.register(
    async (api) => {
      await api.register(authRoutes, {
        prefix: '/auth',
        registerUseCase: {} as never,
        loginUseCase: {} as never,
      });
      await api.register(tenantRoutes, {
        prefix: '/tenant',
        getTenantUseCase: {} as never,
        updateTenantUseCase: {} as never,
        connectWhatsAppUseCase: {} as never,
      });
      await api.register(metaRoutes, {
        prefix: '/meta',
        startMetaOnboardingUseCase: {} as never,
        completeMetaOnboardingUseCase: {} as never,
        checkMetaConnectionUseCase: {} as never,
        embeddedSignupAvailable: false,
      });
      await api.register(flowsRoutes, {
        prefix: '/flows',
        createFlowUseCase: {} as never,
        updateFlowUseCase: {} as never,
        activateFlowUseCase: {} as never,
        deleteFlowUseCase: {} as never,
        getFlowUseCase: {} as never,
        listFlowsUseCase: {} as never,
      });
      await api.register(kbRoutes, {
        prefix: '/kb',
        uploadDocumentUseCase: {} as never,
        listDocumentsUseCase: {} as never,
        deleteDocumentUseCase: {} as never,
      });
      await api.register(conversationsRoutes, {
        prefix: '/conversations',
        listConversationsUseCase: {} as never,
      });
      await api.register(dryrunRoutes, { prefix: '/dry-run', dryRunUseCase: {} as never });

      api.get('/health', async () => ({ status: 'ok' }));
      api.get('/healthz', async () => ({ status: 'ok' }));
      api.get('/readyz', async () => ({ status: 'ok' }));
    },
    { prefix: API_PREFIX },
  );

  await app.ready();
  await app.close();
  return seen;
}

function documentedRoutes(): Set<string> {
  const documented = new Set<string>();
  for (const [path, operations] of Object.entries(spec.paths)) {
    for (const method of Object.keys(operations)) {
      if (HTTP_METHODS.includes(method)) {
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return documented;
}

describe('OpenAPI contract fidelity', () => {
  let registered: Set<string>;

  beforeAll(async () => {
    registered = await collectRegisteredRoutes();
  });

  it('declares the documented server prefix', () => {
    expect(spec.servers.map((s) => s.url)).toContain(API_PREFIX);
  });

  it('every documented route exists in the app', () => {
    const missing = [...documentedRoutes()].filter((route) => !registered.has(route));
    expect(missing).toEqual([]);
  });

  it('every registered route is documented', () => {
    // Fastify auto-creates a HEAD route for every GET; that is framework
    // behaviour, not an API surface, so it is excluded.
    const undocumented = [...registered]
      .filter((route) => !route.startsWith('HEAD '))
      .filter((route) => !documentedRoutes().has(route));
    expect(undocumented).toEqual([]);
  });

  it('every mutating route documents its failure modes', () => {
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const responses = Object.keys(
          (operation as { responses?: Record<string, unknown> }).responses ?? {},
        );
        if (['put', 'patch', 'post', 'delete'].includes(method)) {
          expect(responses.some((code) => code.startsWith('4') || code.startsWith('5'))).toBe(
            true,
          );
          expect(`${method.toUpperCase()} ${path}`).toBeTruthy();
        }
      }
    }
  });
});
