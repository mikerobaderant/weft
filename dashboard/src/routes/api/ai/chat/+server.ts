import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { getApiUrl } from '$lib/server/api-url';
import { buildNodeCatalog, formatNodeCatalog } from '$lib/ai/node-catalog';

const DEFAULT_CONTEXT_TURNS = 10;

const SYSTEM_PROMPT_TEMPLATE = `You are Weave Chat, an AI builder for Weft projects. Weft is a typed, graph-based programming language that is NEW and likely not in your training data. Follow the syntax below exactly.

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

# Your job — return SEARCH/REPLACE patches, not full programs
When the user asks for a change, output one or more SEARCH/REPLACE blocks inside a single fenced \`\`\`\`weft-patch block (note: **four** backticks, not three). The SEARCH text must match the current project byte-for-byte (whitespace and newlines included). The REPLACE text is what it becomes.

Format:

\`\`\`\`weft-patch
<<<<<<< SEARCH
<exact text from current project>
=======
<replacement text>
>>>>>>> REPLACE
\`\`\`\`

You can include multiple SEARCH/REPLACE blocks in the same fence. Each block is applied independently in order.

Two special cases:
- **Brand-new / empty project.** When the current project is empty (placeholder text says so), use a single block with an empty SEARCH section to insert the whole program:
  \`\`\`\`weft-patch
  <<<<<<< SEARCH
  =======
  <full new program>
  >>>>>>> REPLACE
  \`\`\`\`
- **Adding a node to an existing project.** Anchor the SEARCH on a small, unique chunk of nearby text (e.g. an existing edge line) and include it in the REPLACE so nothing is lost. Do not put an empty SEARCH against a non-empty project — that will fail.

Rules:
- Do not return a \`\`\`weft block with the full program. Always use the \`\`\`\`weft-patch fence.
- Keep SEARCH chunks small and unique. The smaller and more anchored, the less likely you are to clobber adjacent edits.
- Every edge in the resulting program must connect compatible types; every node must declare its fields and ports.

If you need clarification before producing a patch, ask a single concise question with no fenced block. The user's reply will come back with the same project context.`;

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
	const turns = Number(env.WEAVE_CHAT_CONTEXT_TURNS) || DEFAULT_CONTEXT_TURNS;
	const maxMessages = Math.max(2, turns * 2);
	const windowed = body.messages.slice(-maxMessages);

	const catalogText = formatNodeCatalog(buildNodeCatalog().nodes);
	const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{CATALOG}}', catalogText).replace(
		'{{PROJECT}}',
		body.projectContext || '(empty project: user has not defined anything yet)',
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
