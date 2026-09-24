import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { invalidRequest } from './reply.js';

// ---------------------------------------------------------------------------
// Request-shape validation for the HTTP layer
// ---------------------------------------------------------------------------
// The domain validators (FlowGraphValidator, the auth use cases) check
// *meaning*. This module checks *shape*, and it exists because it was missing:
// a malformed body reached a use case as `undefined`, threw a TypeError or a
// Prisma error, and the global error handler answered 500 for what was plainly
// a client mistake. Schemathesis found 20 of those against the isolated stack
// (empty bodies, wrong types, `offset` beyond integer range, UUID-typed path
// parameters that were never validated).
//
// Every constraint here mirrors infra/contracts/openapi-tenant-api.json. If the
// two disagree, Schemathesis reports an "API accepted schema-violating request"
// (it found exactly that for `PATCH /tenant` with an empty name, an oversized
// email on register, and a non-date-time `to` filter on conversations).
// ---------------------------------------------------------------------------

/** `body.name` / `query.limit` style path for a Zod issue, for error details. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
    return `${path}: ${issue.message}`;
  });
}

/** Longest path echoed back when a NUL character is rejected. */
const MAX_REPORTED_PATH = 200;

/**
 * Path of the first string containing NUL (U+0000) under `value`, or null.
 *
 * PostgreSQL cannot represent NUL in either `text` or `jsonb`; a parameter
 * carrying one is rejected with `invalid byte sequence for encoding "UTF8":
 * 0x00` (text) or `unsupported Unicode escape sequence` (jsonb). Both surfaced
 * as a 500 for what is plainly a malformed request — Schemathesis found it in
 * `tenant_slug` on `POST /auth/login` and nested inside a flow's `trigger`.
 * JSON permits `\u0000`, so no Zod shape check can rule it out on its own.
 *
 * Iterative rather than recursive: the input is attacker-controlled, and a
 * deeply nested body would otherwise turn the guard itself into a crash.
 */
export function nulPathIn(root: string, value: unknown): string | null {
  const stack: Array<{ node: unknown; path: string }> = [{ node: value, path: root }];

  while (stack.length > 0) {
    const { node, path } = stack.pop() as { node: unknown; path: string };

    if (typeof node === 'string') {
      if (node.includes('\u0000')) {
        return path.length > MAX_REPORTED_PATH ? `${path.slice(0, MAX_REPORTED_PATH)}...` : path;
      }
    } else if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        stack.push({ node: node[i], path: `${path}[${i}]` });
      }
    } else if (typeof node === 'object' && node !== null) {
      for (const [key, child] of Object.entries(node)) {
        // Keys are checked too: `jsonb` cannot hold a NUL in a key either, and
        // `trigger`/`config` are stored as jsonb.
        const childPath = `${path}.${key}`;
        if (key.includes('\u0000')) {
          return childPath.length > MAX_REPORTED_PATH
            ? `${childPath.slice(0, MAX_REPORTED_PATH)}...`
            : childPath;
        }
        stack.push({ node: child, path: childPath });
      }
    }
  }

  return null;
}

/**
 * RFC 3339 date-time, matching the contract's `format: date-time`.
 *
 * Deliberately strict: `new Date('0.5')` is a *valid* Date in V8 (it parses as
 * 2000-05-01), so a `!Number.isNaN(...)` check accepted `?to=0.5` and answered
 * 200 for a value the contract forbids.
 */
const isoDateTime = z.string().datetime({ offset: true });

/** Path parameters that are UUIDs; a malformed value must not reach Prisma. */
export const uuidSchema = z.string().uuid();

/**
 * Validate a `:id` path parameter. Returns the UUID, or answers 400 and
 * returns null so the caller can `return` early.
 *
 * Needed because `GET /flows/not-a-uuid` used to reach Prisma, which threw a
 * malformed-UUID error that surfaced as a 500.
 */
export function requireUuidParam(reply: FastifyReply, value: string): string | null {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    invalidRequest(reply, ['id: must be a UUID']);
    return null;
  }
  return parsed.data;
}

/**
 * `limit` / `offset` arrive as strings. `z.coerce.number()` plus the integer and
 * range constraints reject `offset=8589090050532079304704`, which previously
 * produced a non-integer value and a 500 from the database layer.
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

/**
 * `.strict()` rejects unknown query parameters. Ignoring them is the more
 * common default, but here a mistyped filter (`?wai_d=...`) silently returns an
 * unfiltered page — for a tenant-scoped conversation log that is a footgun, so
 * a typo is an error. Schemathesis flagged the lenient behaviour via its
 * `negative_data_rejection` check.
 */
export const conversationsQuerySchema = paginationSchema
  .extend({
    wa_id: z.string().min(1).max(64).optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
  })
  .strict();

export const registerBodySchema = z.object({
  tenant_name: z.string().trim().min(1).max(120),
  email: z.string().trim().min(3).max(254).email(),
  password: z.string().min(12).max(200),
});

export const loginBodySchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  tenant_slug: z.string().trim().min(1).max(63),
});

export const updateTenantBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
});

export const connectWhatsAppBodySchema = z.object({
  waba_id: z.string().min(1).max(64),
  phone_number_id: z.string().min(1).max(64),
  access_token: z.string().min(1).max(4096),
});

export const embeddedSignupCompleteBodySchema = z.object({
  code: z.string().min(1).max(2048),
  state: z.string().min(1).max(512),
  waba_id: z.string().min(1).max(64).optional(),
  phone_number_id: z.string().min(1).max(64).optional(),
});

export const dryRunBodySchema = z.object({
  message: z.string().min(1).max(4096),
  simulated_wa_id: z.string().min(1).max(64),
});

/**
 * Node `type` is restricted here because it reaches a CHECK constraint on
 * `flow_nodes.type`; an unknown value would surface as a database error (500)
 * instead of a validation failure.
 */
export const flowNodeSchema = z.object({
  node_key: z.string().min(1).max(64),
  type: z.enum([
    'message',
    'interactive',
    'collect_input',
    'condition',
    'rag_lookup',
    'llm_generate',
    'api_call',
    'end',
  ]),
  config: z.record(z.unknown()).default({}),
  transitions: z
    .array(
      z.object({
        next: z.string().min(1).max(64),
        condition: z.string().max(1000).optional(),
      }),
    )
    .default([]),
});

export const createFlowBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  trigger: z.record(z.unknown()),
  entry_node: z.string().min(1).max(64),
  nodes: z.array(flowNodeSchema).min(1).max(50),
});

/** `PUT /flows/:id` carries a partial graph: every field is optional. */
export const updateFlowBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  trigger: z.record(z.unknown()).optional(),
  entry_node: z.string().min(1).max(64).optional(),
  nodes: z.array(flowNodeSchema).min(1).max(50).optional(),
});

export type ConversationsQuery = z.infer<typeof conversationsQuerySchema>;
export type CreateFlowBody = z.infer<typeof createFlowBodySchema>;
export type UpdateFlowBody = z.infer<typeof updateFlowBodySchema>;
