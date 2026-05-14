import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getApiUrl } from '$lib/server/api-url';
import { buildNodeCatalog, formatNodeCatalog } from '$lib/ai/node-catalog';

const DEFAULT_CONTEXT_TURNS = 10;

const SYSTEM_PROMPT_TEMPLATE = `You are Tangle-lite, an AI builder for Weft projects. Weft is a typed, graph-based programming language that is NEW and likely not in your training data. Follow the syntax below exactly.

# Weft syntax reference
Every node is declared as \`name = NodeType { field: value, ... }\`. Edges connect one node's output port to another node's input port using dotted assignment: \`target.inputPort = source.outputPort\`. Ports must have compatible types.

Complete example program:

\`\`\`weft
# Project: Poem Generator
# Description: Writes a short poem about any topic

topic = Text {
  label: "Topic"
  value: "the silence between stars"
}

llm_config = LlmConfig {
  label: "Config"
  provider: "bedrock"
  model: "us.anthropic.claude-sonnet-4-6"
  systemPrompt: "Write a short, beautiful poem (4-6 lines) about the given topic."
  temperature: "0.8"
}

poet = LlmInference -> (response: String) {
  label: "Poet"
}
poet.prompt = topic.value
poet.config = llm_config.config

output = Debug { label: "Poem" }
output.data = poet.response
\`\`\`

Key rules:
- Node fields go inside \`{ }\` as \`key: value\` pairs (one per line or comma-separated).
- Custom output ports declared inline with \`-> (portName: Type)\` after the node type.
- Edges are assignments: \`targetNode.inputPortName = sourceNode.outputPortName\`.
- Strings use double quotes. Numbers and booleans don't need quotes, but the LlmConfig fields like temperature use quoted strings.
- Comments start with \`#\`.
- For LlmConfig, default to \`provider: "bedrock"\` and \`model: "us.anthropic.claude-sonnet-4-6"\` unless the user explicitly requests OpenRouter or a different model. Other valid Bedrock profile IDs: \`us.anthropic.claude-opus-4-7\`, \`us.anthropic.claude-haiku-4-5-20251001-v1:0\`. Do NOT append \`[1m]\` or any bracketed suffix to Bedrock model IDs — that's not valid syntax.

# Available node types
{{CATALOG}}

# Current project
\`\`\`weft
{{PROJECT}}
\`\`\`

# Your job
When the user asks for a change, return the **complete** updated .weft program in a fenced \`\`\`weft code block. Do not return diffs or partial snippets. Keep the existing project structure unless the user explicitly asks for a rewrite. Every edge must connect compatible types; every node must declare its fields and ports.

If you need clarification before writing code, ask a single concise question and do NOT include a code block. The user's message will be shown to you again with their answer.`;

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: {
		messages: { role: string; content: string }[];
		projectContext: string;
		config?: { provider?: string; model?: string; apiKey?: string };
	};
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw error(400, 'messages is required and must be a non-empty array');
	}

	// Truncate to last N turns to keep provider context bounded on long
	// conversations. UI keeps the full history from the DB; only the
	// provider call is trimmed.
	const turns = Number(env.TANGLE_LITE_CONTEXT_TURNS) || DEFAULT_CONTEXT_TURNS;
	const maxMessages = Math.max(2, turns * 2);
	const windowed = body.messages.slice(-maxMessages);

	const catalogText = formatNodeCatalog(buildNodeCatalog().nodes);
	const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{CATALOG}}', catalogText).replace(
		'{{PROJECT}}',
		body.projectContext || '(empty project — user has not defined anything yet)',
	);

	const apiUrl = getApiUrl();
	let upstream: Response;
	try {
		upstream = await fetch(`${apiUrl}/api/v1/ai/chat`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				messages: windowed,
				systemPrompt,
				config: body.config,
			}),
		});
	} catch (e) {
		throw error(502, `Failed to reach weft-api: ${e instanceof Error ? e.message : String(e)}`);
	}

	if (!upstream.ok) {
		const detail = await upstream.text();
		throw error(upstream.status, detail || 'weft-api error');
	}

	const data = await upstream.json();
	return json(data);
};
