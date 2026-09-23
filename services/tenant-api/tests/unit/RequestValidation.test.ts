import type { FastifyReply } from 'fastify';
import {
  conversationsQuerySchema,
  createFlowBodySchema,
  dryRunBodySchema,
  embeddedSignupCompleteBodySchema,
  formatIssues,
  loginBodySchema,
  registerBodySchema,
  requireUuidParam,
  updateTenantBodySchema,
} from '../../src/interfaces/http/validation.js';

// Regression coverage for the request-shape validation added after Schemathesis
// reported 20 server errors against the isolated stack: malformed input reached
// the use cases and surfaced as 500s.

function fakeReply(): {
  reply: FastifyReply;
  captured: { status?: number; body?: unknown };
} {
  const captured: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      captured.status = code;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, captured };
}

describe('registerBodySchema', () => {
  const valid = {
    tenant_name: 'Acme',
    email: 'owner@acme.test',
    password: 'a-long-enough-password',
  };

  it('accepts a well-formed registration', () => {
    expect(registerBodySchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ['missing body', undefined],
    ['empty object', {}],
    ['non-string email', { ...valid, email: 5 }],
    ['array password', { ...valid, password: [] }],
    ['blank tenant name', { ...valid, tenant_name: '   ' }],
    ['password under 12 characters', { ...valid, password: 'short' }],
    ['email without @', { ...valid, email: 'not-an-email' }],
    ['email over 254 characters', { ...valid, email: `${'a'.repeat(300)}@x.test` }],
  ])('rejects %s', (_label: string, body: unknown) => {
    expect(registerBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('loginBodySchema', () => {
  it('accepts a well-formed login', () => {
    expect(
      loginBodySchema.safeParse({ email: 'a@b.test', password: 'x', tenant_slug: 'acme' }).success,
    ).toBe(true);
  });

  it.each([{}, { email: 5 }, { email: 'a@b.test' }])('rejects %p', (body: unknown) => {
    expect(loginBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('updateTenantBodySchema', () => {
  // PATCH /tenant previously accepted `{"name": ""}` and stored an empty name.
  it('rejects an empty name', () => {
    expect(updateTenantBodySchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects a name over 120 characters', () => {
    expect(updateTenantBodySchema.safeParse({ name: 'n'.repeat(121) }).success).toBe(false);
  });

  it('rejects a missing name', () => {
    expect(updateTenantBodySchema.safeParse({}).success).toBe(false);
  });

  it('accepts a normal name', () => {
    expect(updateTenantBodySchema.safeParse({ name: 'Acme' }).success).toBe(true);
  });
});

describe('conversationsQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(conversationsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('coerces limit and offset to integers', () => {
    const parsed = conversationsQuerySchema.safeParse({ limit: '10', offset: '20' });
    expect(parsed.success && parsed.data.limit).toBe(10);
    expect(parsed.success && parsed.data.offset).toBe(20);
  });

  it.each([
    ['a non-date-time `to`', { to: '0.5' }],
    ['an empty `to`', { to: '' }],
    ['a date-only `to`', { to: '2026-09-23' }],
    ['a malformed `from`', { from: 'yesterday' }],
    ['limit below 1', { limit: '0' }],
    ['an offset beyond integer range', { offset: '8589090050532079304704' }],
    ['a non-numeric limit', { limit: 'many' }],
    ['an unknown query parameter', { 'x-unknown': '1' }],
    ['an oversized wa_id', { wa_id: 'w'.repeat(65) }],
  ])('rejects %s', (_label: string, query: unknown) => {
    expect(conversationsQuerySchema.safeParse(query).success).toBe(false);
  });

  it('accepts RFC 3339 timestamps with and without an offset', () => {
    expect(conversationsQuerySchema.safeParse({ to: '2026-09-23T13:28:51.491Z' }).success).toBe(
      true,
    );
    expect(conversationsQuerySchema.safeParse({ from: '2026-09-23T13:28:51+02:00' }).success).toBe(
      true,
    );
  });
});

describe('createFlowBodySchema', () => {
  const valid = {
    name: 'Welcome',
    trigger: {},
    entry_node: 'start',
    nodes: [{ node_key: 'start', type: 'end' }],
  };

  it('accepts a minimal graph and defaults config/transitions', () => {
    const parsed = createFlowBodySchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.nodes[0]?.config).toEqual({});
    expect(parsed.success && parsed.data.nodes[0]?.transitions).toEqual([]);
  });

  it.each([
    ['nodes replaced by a string', { ...valid, nodes: 'nope' }],
    ['nodes missing', { ...valid, nodes: undefined }],
    ['an empty nodes array', { ...valid, nodes: [] }],
    ['an unknown node type', { ...valid, nodes: [{ node_key: 's', type: 'bogus' }] }],
    ['a node without node_key', { ...valid, nodes: [{ type: 'end' }] }],
    ['a non-object trigger', { ...valid, trigger: 'x' }],
    ['a blank name', { ...valid, name: '' }],
  ])('rejects %s', (_label: string, body: unknown) => {
    expect(createFlowBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('embeddedSignupCompleteBodySchema', () => {
  it('accepts code + state without the optional ids', () => {
    expect(
      embeddedSignupCompleteBodySchema.safeParse({ code: 'c', state: 's' }).success,
    ).toBe(true);
  });

  it.each([{}, { code: 'c' }, { state: 's' }, { code: '', state: 's' }])(
    'rejects %p',
    (body: unknown) => {
      expect(embeddedSignupCompleteBodySchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('dryRunBodySchema', () => {
  it('accepts a well-formed dry run', () => {
    expect(dryRunBodySchema.safeParse({ message: 'hi', simulated_wa_id: '521' }).success).toBe(
      true,
    );
  });

  it.each([{}, { message: 'hi' }, { message: '', simulated_wa_id: '521' }])(
    'rejects %p',
    (body: unknown) => {
      expect(dryRunBodySchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('formatIssues', () => {
  it('names the offending field', () => {
    const parsed = updateTenantBodySchema.safeParse({ name: '' });
    if (parsed.success) throw new Error('expected a failure');
    expect(formatIssues(parsed.error).join(' ')).toMatch(/^name: /);
  });

  it('falls back to `body` when the error has no path', () => {
    const parsed = registerBodySchema.safeParse(undefined);
    if (parsed.success) throw new Error('expected a failure');
    expect(formatIssues(parsed.error).length).toBeGreaterThan(0);
  });
});

describe('requireUuidParam', () => {
  it('returns the uuid and writes no response', () => {
    const { reply, captured } = fakeReply();
    const id = requireUuidParam(reply, 'a141b259-fae7-4ada-868c-8c7817ac9cec');
    expect(id).toBe('a141b259-fae7-4ada-868c-8c7817ac9cec');
    expect(captured.status).toBeUndefined();
  });

  it.each(['not-a-uuid', 'null,null', 'a141b259'])(
    'rejects %s with 400',
    (value: string) => {
      const { reply, captured } = fakeReply();
      expect(requireUuidParam(reply, value)).toBeNull();
      expect(captured.status).toBe(400);
      expect(captured.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    },
  );
});
