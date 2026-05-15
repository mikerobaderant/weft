import { describe, it, expect } from 'vitest';
import { stripSensitiveFields, restoreSensitiveFields } from '$lib/ai/sanitize';
import type { NodeInstance } from '$lib/types';

function makeLlmConfig(id: string, apiKey: string): NodeInstance {
	return {
		id,
		nodeType: 'LlmConfig',
		label: null,
		config: {
			apiKey,
			model: 'anthropic/claude-sonnet-4.6',
			provider: 'openrouter',
		},
		position: { x: 0, y: 0 },
		inputs: [],
		outputs: [],
		features: {},
	};
}

describe('sanitize round-trip (strip → restore)', () => {
	it('restoreSensitiveFields rewrites the original apiKey value', () => {
		const node = makeLlmConfig('cfg', 'sk-secret-123');
		const weft = `cfg = LlmConfig {
  apiKey: "sk-secret-123"
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}`;

		const stripped = stripSensitiveFields(weft, [node]);
		// Sanity: the secret is gone after stripping.
		expect(stripped).not.toContain('sk-secret-123');

		const restored = restoreSensitiveFields(stripped, [node]);
		// The real value is back.
		expect(restored).toContain('sk-secret-123');
	});

	it('restore is a no-op when the original value was empty', () => {
		const node = makeLlmConfig('cfg', '');
		const weft = `cfg = LlmConfig {
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}`;

		const restored = restoreSensitiveFields(weft, [node]);
		// Should not have invented an apiKey field that the user never set.
		expect(restored).not.toMatch(/apiKey:/);
	});

	it('restore short-circuits when the patch deleted the node entirely', () => {
		const node = makeLlmConfig('cfg', 'sk-secret-123');
		// Simulates the model returning a patch that removed the LlmConfig node.
		const patchedSource = `other = Text { value: "still here" }`;

		const restored = restoreSensitiveFields(patchedSource, [node]);
		// updateNodeConfig short-circuits when the node id isn't found, so the
		// patched source is unchanged. The deleted node's old apiKey is NOT
		// re-inserted into a node that no longer exists.
		expect(restored).toBe(patchedSource);
		expect(restored).not.toContain('sk-secret-123');
	});

	it('does not touch non-sensitive field values', () => {
		const node = makeLlmConfig('cfg', 'sk-secret-123');
		const weft = `cfg = LlmConfig {
  apiKey: "sk-secret-123"
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}`;

		const restored = restoreSensitiveFields(stripSensitiveFields(weft, [node]), [node]);
		expect(restored).toContain('model: "anthropic/claude-sonnet-4.6"');
		expect(restored).toContain('provider: "openrouter"');
	});
});
