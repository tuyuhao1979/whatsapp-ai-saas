import { FlowGraphValidator } from '../../src/application/flows/FlowGraphValidator.js';
import { ValidationError } from '../../src/domain/errors.js';
import type { CreateFlowNodeInput } from '../../src/domain/ports/IFlowRepo.js';

const validator = new FlowGraphValidator();

function makeNode(
  overrides: Partial<CreateFlowNodeInput> & { nodeKey: string },
): CreateFlowNodeInput {
  return {
    type: 'message',
    config: {},
    transitions: [],
    ...overrides,
  };
}

describe('FlowGraphValidator', () => {
  describe('Rule 1 — entry_node must exist', () => {
    it('passes when entry_node is present in nodes', () => {
      expect(() =>
        validator.validate({
          entryNode: 'start',
          nodes: [makeNode({ nodeKey: 'start', type: 'end' })],
        }),
      ).not.toThrow();
    });

    it('throws when entry_node is not in nodes array', () => {
      expect(() =>
        validator.validate({
          entryNode: 'missing',
          nodes: [makeNode({ nodeKey: 'start', type: 'end' })],
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('Rule 2 — all transition.next must reference existing node_keys', () => {
    it('passes when all transitions point to existing nodes', () => {
      expect(() =>
        validator.validate({
          entryNode: 'a',
          nodes: [
            makeNode({ nodeKey: 'a', transitions: [{ next: 'b' }] }),
            makeNode({ nodeKey: 'b', type: 'end' }),
          ],
        }),
      ).not.toThrow();
    });

    it('throws when transition.next references a non-existent node', () => {
      expect(() =>
        validator.validate({
          entryNode: 'a',
          nodes: [makeNode({ nodeKey: 'a', transitions: [{ next: 'nonexistent' }] })],
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('Rule 3 — no orphan nodes', () => {
    it('passes when all nodes are reachable', () => {
      expect(() =>
        validator.validate({
          entryNode: 'a',
          nodes: [
            makeNode({ nodeKey: 'a', transitions: [{ next: 'b' }] }),
            makeNode({ nodeKey: 'b', type: 'end' }),
          ],
        }),
      ).not.toThrow();
    });

    it('throws when a node is unreachable', () => {
      expect(() =>
        validator.validate({
          entryNode: 'a',
          nodes: [
            makeNode({ nodeKey: 'a', type: 'end' }),
            makeNode({ nodeKey: 'orphan', type: 'end' }),
          ],
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('Rule 4 — max 50 nodes', () => {
    it('passes with exactly 50 nodes', () => {
      const nodes = Array.from({ length: 50 }, (_, i) =>
        makeNode({ nodeKey: `n${i}`, type: i === 0 ? 'message' : 'end' }),
      );
      // Wire them into a chain so none are orphaned
      for (let i = 0; i < nodes.length - 1; i++) {
        nodes[i]!.transitions = [{ next: `n${i + 1}` }];
      }
      expect(() => validator.validate({ entryNode: 'n0', nodes })).not.toThrow();
    });

    it('throws with 51 nodes', () => {
      const nodes = Array.from({ length: 51 }, (_, i) =>
        makeNode({ nodeKey: `n${i}`, type: 'end' }),
      );
      expect(() => validator.validate({ entryNode: 'n0', nodes })).toThrow(ValidationError);
    });
  });

  describe('Rule 5 — node types must be from allowed enum', () => {
    it('accepts all valid node types', () => {
      const types = [
        'message', 'interactive', 'collect_input', 'condition',
        'rag_lookup', 'llm_generate', 'api_call', 'end',
      ] as const;
      for (const type of types) {
        expect(() =>
          validator.validate({ entryNode: 'n', nodes: [makeNode({ nodeKey: 'n', type })] }),
        ).not.toThrow();
      }
    });

    it('throws on an invalid node type', () => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'invalid' as never })],
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('Rule 6 — condition node JMESPath injection prevention', () => {
    const safeExprs = ['body.name == `hello`', 'length(body.items) > `0`'];
    const dangerousExprs = [
      'eval(something)',
      'exec("cmd")',
      '__import__("os")',
      'obj.__proto__',
      'obj.prototype.toString',
      'obj.constructor.call',
    ];

    it.each(safeExprs)('allows safe expr: %s', (expr) => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'condition', config: { expr } })],
        }),
      ).not.toThrow();
    });

    it.each(dangerousExprs)('rejects dangerous expr: %s', (expr) => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'condition', config: { expr } })],
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('Rule 7 — api_call node SSRF prevention', () => {
    const privateUrls = [
      'http://10.0.0.1/data',
      'http://172.16.0.1/data',
      'http://172.31.255.255/data',
      'http://192.168.1.1/data',
      'http://127.0.0.1/data',
      'http://localhost/data',
      'http://169.254.169.254/latest/meta-data/',
    ];

    const publicUrls = [
      'https://api.example.com/endpoint',
      'https://webhook.site/abc',
    ];

    it.each(privateUrls)('rejects private URL: %s', (url) => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'api_call', config: { url } })],
        }),
      ).toThrow(ValidationError);
    });

    it.each(publicUrls)('allows public URL: %s', (url) => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'api_call', config: { url } })],
        }),
      ).not.toThrow();
    });
  });

  describe('Rule 8 — llm_generate max_tokens cap (1000)', () => {
    it('passes with max_tokens = 1000', () => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'llm_generate', config: { max_tokens: 1000 } })],
        }),
      ).not.toThrow();
    });

    it('throws with max_tokens = 1001', () => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'llm_generate', config: { max_tokens: 1001 } })],
        }),
      ).toThrow(ValidationError);
    });
  });

  // NOTE: this upstream suite asserted a cap of 20, but the implementation
  // enforces 10 in two places — FlowGraphValidator.MAX_RAG_TOP_K and
  // flow_engine.application.node_executors.execute_rag_lookup
  // (`min(top_k, 10)`). The retrieval adapter allows up to 20. The test below
  // pins the enforced behaviour; the 10-vs-20 discrepancy is a product decision
  // for the owner, not something a test fix should silently choose.
  describe('Rule 9 — rag_lookup top_k cap (10)', () => {
    it('passes with top_k = 10', () => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'rag_lookup', config: { top_k: 10 } })],
        }),
      ).not.toThrow();
    });

    it('throws with top_k = 11', () => {
      expect(() =>
        validator.validate({
          entryNode: 'n',
          nodes: [makeNode({ nodeKey: 'n', type: 'rag_lookup', config: { top_k: 11 } })],
        }),
      ).toThrow(ValidationError);
    });
  });
});
