export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type ChatConfig = {
	provider?: string;
	model?: string;
	apiKey?: string;
};

export type ChatResponse = {
	text: string;
	weftPatch?: string | null;
	provider: string;
	model: string;
};

export async function postChat(input: {
	messages: ChatMessage[];
	projectContext: string;
	config?: ChatConfig;
}): Promise<ChatResponse> {
	const res = await fetch('/api/ai/chat', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(text || `Chat request failed: ${res.status}`);
	}
	return res.json();
}
