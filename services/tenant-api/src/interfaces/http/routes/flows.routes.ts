import type { FastifyPluginAsync } from 'fastify';
import type { CreateFlowUseCase } from '../../../application/flows/CreateFlowUseCase.js';
import type { UpdateFlowUseCase } from '../../../application/flows/UpdateFlowUseCase.js';
import type { ActivateFlowUseCase } from '../../../application/flows/ActivateFlowUseCase.js';
import type { DeleteFlowUseCase } from '../../../application/flows/DeleteFlowUseCase.js';
import type { GetFlowUseCase, ListFlowsUseCase } from '../../../application/flows/GetFlowUseCase.js';
import { ok, sendDomainError } from '../reply.js';

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
    try {
      const flow = await opts.createFlowUseCase.execute(request.tenantId, {
        name: request.body.name,
        description: request.body.description,
        trigger: request.body.trigger,
        entryNode: request.body.entry_node,
        nodes: request.body.nodes.map((n) => ({
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
    try {
      const flow = await opts.getFlowUseCase.execute(request.tenantId, request.params.id);
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
    try {
      const body = request.body;
      const flow = await opts.updateFlowUseCase.execute(
        request.tenantId,
        request.params.id,
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
      try {
        const flow = await opts.activateFlowUseCase.execute(request.tenantId, request.params.id);
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
      try {
        await opts.deleteFlowUseCase.execute(request.tenantId, request.params.id);
        ok(reply, null, 204);
      } catch (err) {
        sendDomainError(reply, err);
      }
    },
  );
};
