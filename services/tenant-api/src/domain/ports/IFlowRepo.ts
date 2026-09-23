import type { Flow, FlowWithNodes, NodeType, Transition } from '../models/Flow.js';

export interface CreateFlowNodeInput {
  nodeKey: string;
  type: NodeType;
  config: Record<string, unknown>;
  transitions: Transition[];
}

export interface CreateFlowInput {
  tenantId: string;
  name: string;
  description?: string;
  trigger: Record<string, unknown>;
  entryNode: string;
  nodes: CreateFlowNodeInput[];
}

export interface UpdateFlowInput {
  name?: string;
  description?: string;
  trigger?: Record<string, unknown>;
  entryNode?: string;
  nodes?: CreateFlowNodeInput[];
}

export interface IFlowRepo {
  findById(id: string): Promise<FlowWithNodes | null>;
  listByTenant(tenantId: string): Promise<Flow[]>;
  create(input: CreateFlowInput): Promise<FlowWithNodes>;
  /** Creates a new version of the flow; increments version number. */
  createNewVersion(id: string, input: UpdateFlowInput): Promise<FlowWithNodes>;
  setActive(id: string, isActive: boolean): Promise<Flow>;
  /** Deactivate all flows whose trigger overlaps with the given one. */
  deactivateByTrigger(tenantId: string, excludeId: string): Promise<void>;
  delete(id: string): Promise<void>;
}
