import type { FastifyPluginAsync } from 'fastify';
import type { CreateFlowUseCase } from '../../../application/flows/CreateFlowUseCase.js';
import type { UpdateFlowUseCase } from '../../../application/flows/UpdateFlowUseCase.js';
import type { ActivateFlowUseCase } from '../../../application/flows/ActivateFlowUseCase.js';
import type { DeleteFlowUseCase } from '../../../application/flows/DeleteFlowUseCase.js';
import type { GetFlowUseCase, ListFlowsUseCase } from '../../../application/flows/GetFlowUseCase.js';
import { invalidRequest, ok, sendDomainError } from '../reply.js';
import {
  createFlowBodySchema,
  formatIssues,
  requireUuidParam,
  updateFlowBodySchema,
} from '../validation.js';

interface FlowRoutesDeps {
  createFlowUseCase: CreateFlowUseCase;
  updateFlowUseCase: UpdateFlowUseCase;
  activateFlowUseCase: ActivateFlowUseCase;
  deleteFlowUseCase: DeleteFlowUseCase;
  getFlowUseCase: GetFlowUseCase;
  listFlowsUseCase: ListFlowsUseCase;
}

export const flowsRoutes: FastifyPluginAsync<FlowRoutesDeps> = async (fastify, opts) => {
  fastify.addHook('preHandler', fastify.authenticate);

  // Mutations require owner/admin (audit finding H5: a viewer could previously
  // create, activate, rewrite and delete flows).
  const ownerOrAdmin = [fastify.authorize('owner', 'admin')];

  /** GET /api/v1/flows */
  fastify.get('/', async (request, reply) => {
    try {
      const flows = await opts.listFlowsUseCase.execute(request.tenantId);
      ok(reply, flows.map((f) => ({
        id: f.id,
        name: f.name,
        is_active: f.isActive,
        version: f.version,
        trigger: f.trigger,
      })));
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /** POST /api/v1/flows */
  fastify.post<{
    Body: {
      name: string;
      description?: string;
      trigger: Record<string, unknown>;
      entry_node: string;
      nodes: Array<{
        node_key: string;
        type: string;
        config: Record<string, unknown>;
        transitions: Array<{ next: string; condition?: string }>;
      }>;
    };
  }>('/', { preHandler: ownerOrAdmin }, async (request, reply) => {
    const parsed = createFlowBodySchema.safeParse(request.body);
    if (!parsed.success) {
      invalidRequest(reply, formatIssues(parsed.error));
      return;
    }

    try {
      const flow = await opts.createFlowUseCase.execute(request.tenantId, {
        name: parsed.data.name,
        description: parsed.data.description,
        trigger: parsed.data.trigger,
        entryNode: parsed.data.entry_node,
        nodes: parsed.data.nodes.map((n) => ({
          nodeKey: n.node_key,
          type: n.type as never,
          config: n.config,
          transitions: n.transitions,
        })),
      });
      ok(reply, flow, 201);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /** GET /api/v1/flows/:id */
  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const id = requireUuidParam(reply, request.params.id);
    if (id === null) return;

    try {
      const flow = await opts.getFlowUseCase.execute(request.tenantId, id);
      ok(reply, flow);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /** PUT /api/v1/flows/:id */
  fastify.put<{
    Params: { id: string };
    Body: {
      name?: string;
      description?: string;
      trigger?: Record<string, unknown>;
      entry_node?: string;
      nodes?: Array<{
        node_key: string;
        type: string;
        config: Record<string, unknown>;
        transitions: Array<{ next: string; condition?: string }>;
      }>;
    };
  }>('/:id', { preHandler: ownerOrAdmin }, async (request, reply) => {
    const id = requireUuidParam(reply, request.params.id);
    if (id === null) return;

    const parsed = updateFlowBodySchema.safeParse(request.body);
    if (!parsed.success) {
      invalidRequest(reply, formatIssues(parsed.error));
      return;
    }

    try {
      const body = parsed.data;
      const flow = await opts.updateFlowUseCase.execute(
        request.tenantId,
        id,
        {
          name: body.name,
          description: body.description,
          trigger: body.trigger,
          entryNode: body.entry_node,
          nodes: body.nodes?.map((n) => ({
            nodeKey: n.node_key,
            type: n.type as never,
            config: n.config,
            transitions: n.transitions,
          })),
        },
      );
      ok(reply, flow);
    } catch (err) {
      sendDomainError(reply, err);
    }
  });

  /** POST /api/v1/flows/:id/activate */
  fastify.post<{ Params: { id: string } }>(
    '/:id/activate',
    { preHandler: ownerOrAdmin },
    async (request, reply) => {
      const id = requireUuidParam(reply, request.params.id);
      if (id === null) return;

      try {
        const flow = await opts.activateFlowUseCase.execute(request.tenantId, id);
        ok(reply, { id: flow.id, is_active: flow.isActive });
      } catch (err) {
        sendDomainError(reply, err);
      }
    },
  );

  /** DELETE /api/v1/flows/:id */
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: ownerOrAdmin },
    async (request, reply) => {
      const id = requireUuidParam(reply, request.params.id);
      if (id === null) return;

      try {
        await opts.deleteFlowUseCase.execute(request.tenantId, id);
        ok(reply, null, 204);
      } catch (err) {
        sendDomainError(reply, err);
      }
    },
  );
};
