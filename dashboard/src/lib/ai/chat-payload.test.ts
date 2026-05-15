import { describe, it, expect } from 'vitest';
import { buildChatPayload, applyChatResponse } from '$lib/ai/chat-payload';
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

const SECRET = 'fake-test-apikey-do-not-rotate';

const WEFT_WITH_SECRET = `cfg = LlmConfig {
  apiKey: "${SECRET}"
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}`;

describe('buildChatPayload: outbound security contract', () => {
	it('strips sensitive values from projectContext', () => {
		const node = makeLlmConfig('cfg', SECRET);
		const { projectContext } = buildChatPayload(WEFT_WITH_SECRET, [node]);
		expect(projectContext).not.toContain(SECRET);
	});

	it('preserves non-sensitive content in projectContext', () => {
		const node = makeLlmConfig('cfg', SECRET);
		const { projectContext } = buildChatPayload(WEFT_WITH_SECRET, [node]);
		expect(projectContext).toContain('anthropic/claude-sonnet-4.6');
		expect(projectContext).toContain('provider: "openrouter"');
		expect(projectContext).toContain('cfg = LlmConfig');
	});

	it('is a no-op when no node holds a sensitive value', () => {
		const node = makeLlmConfig('cfg', '');
		const weft = `cfg = LlmConfig {
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}`;
		const { projectContext } = buildChatPayload(weft, [node]);
		expect(projectContext).toBe(weft);
	});
});

describe('applyChatResponse: inbound security contract', () => {
	it('puts the original secret back after the model edits an unrelated field', () => {
		const node = makeLlmConfig('cfg', SECRET);
		// Model patch (computed against the sanitized view) renames the model field.
		const patch = `<<<<<<< SEARCH
  model: "anthropic/claude-sonnet-4.6"
=======
  model: "anthropic/claude-opus-4.6"
>>>>>>> REPLACE`;

		const { restored, errors, lostSecrets } = applyChatResponse(
			WEFT_WITH_SECRET,
			[node],
			patch,
		);

		// Secret survived. This is the security claim of the whole flow.
		expect(restored).toContain(SECRET);
		// Model's edit landed.
		expect(restored).toContain('anthropic/claude-opus-4.6');
		expect(errors).toHaveLength(0);
		expect(lostSecrets).toHaveLength(0);
	});

	it('reports lost secrets when the patch renames the node holding one', () => {
		const node = makeLlmConfig('cfg', SECRET);
		// Naive patch (model wrote the whole node back with the new id; in
		// practice the model would emit a SEARCH that matches the existing
		// declaration, but the effect on the renamed source is the same:
		// `cfg` is gone.)
		const renamedSource = `myConfig = LlmConfig {
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}`;
		// applyChatResponse with a no-op patch over the renamed source still
		// runs the lost-secrets audit. Use an empty-on-empty trick here by
		// constructing a patch that makes a benign edit somewhere harmless,
		// or just call applyChatResponse with a SEARCH that targets the
		// renamed source.
		const patch = `<<<<<<< SEARCH
myConfig = LlmConfig {
  model: "anthropic/claude-sonnet-4.6"
  provider: "openrouter"
}
=======
${renamedSource}
>>>>>>> REPLACE`;

		const { restored, lostSecrets } = applyChatResponse(renamedSource, [node], patch);

		// The renamed source has no apiKey; restore couldn't find `cfg`,
		// so the secret is reported as lost.
		expect(restored).not.toContain(SECRET);
		expect(lostSecrets).toHaveLength(1);
		expect(lostSecrets[0]).toMatchObject({ nodeId: 'cfg', fieldKey: 'apiKey' });
	});

	it('reports patch-block errors for unmatched SEARCH text', () => {
		const node = makeLlmConfig('cfg', SECRET);
		const patch = `<<<<<<< SEARCH
this text is not in the source
=======
neither is this
>>>>>>> REPLACE`;

		const { restored, errors } = applyChatResponse(WEFT_WITH_SECRET, [node], patch);

		expect(errors.length).toBeGreaterThan(0);
		// Source is unchanged when the SEARCH didn't match.
		expect(restored).toContain(SECRET);
		expect(restored).toContain('anthropic/claude-sonnet-4.6');
	});

	it('handles patch with multiple blocks, one valid and one bad', () => {
		const node = makeLlmConfig('cfg', SECRET);
		const patch = `<<<<<<< SEARCH
  provider: "openrouter"
=======
  provider: "bedrock"
>>>>>>> REPLACE
<<<<<<< SEARCH
this text is not in the source
=======
ignored
>>>>>>> REPLACE`;

		const { restored, errors, lostSecrets } = applyChatResponse(
			WEFT_WITH_SECRET,
			[node],
			patch,
		);

		// Valid block applied.
		expect(restored).toContain('provider: "bedrock"');
		// Invalid block reported.
		expect(errors).toHaveLength(1);
		// Secret survived through both.
		expect(restored).toContain(SECRET);
		expect(lostSecrets).toHaveLength(0);
	});
});
