import { ValidationError } from '../../domain/errors.js';
import type { CreateFlowNodeInput } from '../../domain/ports/IFlowRepo.js';

const MAX_NODES = 50;
const MAX_LLM_TOKENS = 1000;
const MAX_RAG_TOP_K = 10;

const ALLOWED_NODE_TYPES = new Set([
  'message',
  'interactive',
  'collect_input',
  'condition',
  'rag_lookup',
  'llm_generate',
  'api_call',
  'end',
]);

// Dangerous patterns to reject in JMESPath expressions (condition nodes)
const JMESPATH_INJECTION_PATTERNS = [
  /eval/i,
  /exec/i,
  /import/i,
  /__/,
  /prototype/i,
  /constructor/i,
];

// Private IP ranges to reject in api_call node URLs — SSRF prevention
const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/10\.\d+\.\d+\.\d+/,            // 10.0.0.0/8
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,  // 172.16.0.0/12
  /^https?:\/\/192\.168\.\d+\.\d+/,            // 192.168.0.0/16
  /^https?:\/\/127\.\d+\.\d+\.\d+/,            // 127.0.0.0/8
  /^https?:\/\/::1/,                            // IPv6 loopback
  /^https?:\/\/\[::1\]/,                        // IPv6 loopback (bracket)
  /^https?:\/\/169\.254\.\d+\.\d+/,            // link-local / AWS metadata
  /^https?:\/\/metadata\./i,                    // metadata.google.internal etc.
  /^https?:\/\/localhost/i,                     // localhost
];

export interface FlowInput {
  entryNode: string;
  nodes: CreateFlowNodeInput[];
}

export class FlowGraphValidator {
  /**
   * Validates a flow definition before persisting.
   * Throws ValidationError with all accumulated violations.
   */
  validate(flow: FlowInput): void {
    const errors: string[] = [];
    const nodeKeys = new Set(flow.nodes.map((n) => n.nodeKey));

    // Rule 1: entry_node must exist
    if (!nodeKeys.has(flow.entryNode)) {
      errors.push(`entry_node '${flow.entryNode}' does not exist in the nodes array`);
    }

    // Rule 4: max 50 nodes
    if (flow.nodes.length > MAX_NODES) {
      errors.push(`Flow exceeds maximum of ${MAX_NODES} nodes (got ${flow.nodes.length})`);
    }

    for (const node of flow.nodes) {
      // Rule 5: node type must be from allowed enum
      if (!ALLOWED_NODE_TYPES.has(node.type)) {
        errors.push(`Node '${node.nodeKey}' has invalid type '${node.type}'`);
      }

      // Rule 2: all transition.next must reference existing node_keys
      for (const transition of node.transitions) {
        if (!nodeKeys.has(transition.next)) {
          errors.push(
            `Node '${node.nodeKey}' has transition to non-existent node '${transition.next}'`,
          );
        }
      }

      // Rule 6: condition node — reject dangerous JMESPath expressions
      if (node.type === 'condition') {
        const expr = node.config['expr'];
        if (typeof expr === 'string') {
          for (const pattern of JMESPATH_INJECTION_PATTERNS) {
            if (pattern.test(expr)) {
              errors.push(
                `Node '${node.nodeKey}': condition expr contains forbidden pattern '${pattern.source}'`,
              );
              break;
            }
          }
        }
      }

      // Rule 7: api_call node — reject private IP ranges (SSRF prevention)
      if (node.type === 'api_call') {
        const url = node.config['url'];
        if (typeof url === 'string') {
          for (const pattern of PRIVATE_IP_PATTERNS) {
            if (pattern.test(url)) {
              errors.push(
                `Node '${node.nodeKey}': api_call URL targets a private/reserved address (SSRF prevention)`,
              );
              break;
            }
          }
        }
      }

      // Rule 8: llm_generate node — max_tokens cap
      if (node.type === 'llm_generate') {
        const maxTokens = node.config['max_tokens'];
        if (typeof maxTokens === 'number' && maxTokens > MAX_LLM_TOKENS) {
          errors.push(
            `Node '${node.nodeKey}': llm_generate max_tokens (${maxTokens}) exceeds limit of ${MAX_LLM_TOKENS}`,
          );
        }
      }

      // Rule 9: rag_lookup node — top_k cap
      if (node.type === 'rag_lookup') {
        const topK = node.config['top_k'];
        if (typeof topK === 'number' && topK > MAX_RAG_TOP_K) {
          errors.push(
            `Node '${node.nodeKey}': rag_lookup top_k (${topK}) exceeds limit of ${MAX_RAG_TOP_K}`,
          );
        }
      }
    }

    // Rule 3: No orphan nodes — every node reachable from entryNode via BFS
    if (errors.length === 0 && nodeKeys.has(flow.entryNode)) {
      const reachable = new Set<string>();
      const queue: string[] = [flow.entryNode];

      while (queue.length > 0) {
        const current = queue.shift()!;
        if (reachable.has(current)) continue;
        reachable.add(current);

        const node = flow.nodes.find((n) => n.nodeKey === current);
        if (node) {
          for (const t of node.transitions) {
            if (!reachable.has(t.next)) {
              queue.push(t.next);
            }
          }
        }
      }

      for (const key of nodeKeys) {
        if (!reachable.has(key)) {
          errors.push(`Node '${key}' is unreachable from entry_node '${flow.entryNode}'`);
        }
      }
    }

    if (errors.length > 0) {
      throw new ValidationError('Flow graph validation failed', errors);
    }
  }
}
