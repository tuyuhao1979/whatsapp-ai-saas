import Fastify, { type FastifyInstance } from 'fastify';
import { authPlugin } from '../../src/interfaces/http/plugins/authPlugin.js';
import {
  authorizePlugin,
  isUserRole,
} from '../../src/interfaces/http/plugins/authorizePlugin.js';

/**
 * RBAC (audit finding H5).
 *
 * The JWT already carried a role claim constrained to owner/admin/viewer but no
 * route ever consulted it, so a viewer could delete flows, wipe the knowledge
 * base, and rebind the tenant's WhatsApp access token.
 */
const JWT_SECRET = 'x'.repeat(40);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin, {
    config: { JWT_SECRET } as never,
  });
  await app.register(authorizePlugin);

  app.get('/read', { preHandler: [app.authenticate] }, async () => ({ ok: 'read' }));

  app.post(
    '/write',
    { preHandler: [app.authenticate, app.authorize('owner', 'admin')] },
    async () => ({ ok: 'write' }),
  );

  app.post(
    '/privileged',
    { preHandler: [app.authenticate, app.authorizeAtLeast('admin')] },
    async () => ({ ok: 'privileged' }),
  );

  await app.ready();
  return app;
}

function token(app: FastifyInstance, role: string): string {
  return app.jwt.sign(
    { sub: 'user-1', tid: '11111111-1111-4111-8111-111111111111', role },
    { expiresIn: '5m' },
  );
}

describe('authorizePlugin', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a request with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/read' });
    expect(res.statusCode).toBe(401);
  });

  it('lets every authenticated role read', async () => {
    for (const role of ['owner', 'admin', 'viewer']) {
      const res = await app.inject({
        method: 'GET',
        url: '/read',
        headers: { authorization: `Bearer ${token(app, role)}` },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('allows owner and admin to write', async () => {
    for (const role of ['owner', 'admin']) {
      const res = await app.inject({
        method: 'POST',
        url: '/write',
        headers: { authorization: `Bearer ${token(app, role)}` },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('forbids a viewer from writing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: `Bearer ${token(app, 'viewer')}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('enforces a minimum role rank', async () => {
    const viewer = await app.inject({
      method: 'POST',
      url: '/privileged',
      headers: { authorization: `Bearer ${token(app, 'viewer')}` },
    });
    expect(viewer.statusCode).toBe(403);

    const admin = await app.inject({
      method: 'POST',
      url: '/privileged',
      headers: { authorization: `Bearer ${token(app, 'admin')}` },
    });
    expect(admin.statusCode).toBe(200);

    const owner = await app.inject({
      method: 'POST',
      url: '/privileged',
      headers: { authorization: `Bearer ${token(app, 'owner')}` },
    });
    expect(owner.statusCode).toBe(200);
  });

  it('fails closed for an unknown role claim', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: `Bearer ${token(app, 'superuser')}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a token signed with a different secret', async () => {
    const evil = Fastify();
    await evil.register(authPlugin, { config: { JWT_SECRET: 'y'.repeat(40) } as never });
    await evil.ready();
    const forged = evil.jwt.sign({ sub: 'u', tid: 't', role: 'owner' }, { expiresIn: '5m' });
    await evil.close();

    const res = await app.inject({
      method: 'POST',
      url: '/write',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('isUserRole', () => {
  it('accepts only the three documented roles', () => {
    expect(['owner', 'admin', 'viewer'].every(isUserRole)).toBe(true);
    expect(isUserRole('superuser')).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
    expect(isUserRole(3)).toBe(false);
  });
});
