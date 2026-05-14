import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import * as db from '$lib/server/db';
import { requireUserId } from '$lib/server/auth-locals';

export const POST = async (event: RequestEvent) => {
	const userId = requireUserId(event);
	try {
		await db.initDb();
		const body = await event.request.json();
		if (body.role !== 'user' && body.role !== 'assistant') {
			return json({ error: 'role must be user or assistant' }, { status: 400 });
		}
		if (typeof body.content !== 'string') {
			return json({ error: 'content must be a string' }, { status: 400 });
		}
		const msg = await db.appendAiMessage(event.params.chatId!, userId, body.role, body.content);
		if (!msg) return json({ error: 'Chat not found' }, { status: 404 });
		return json(msg, { status: 201 });
	} catch (error) {
		console.error('Failed to append message:', error);
		return json({ error: 'Failed to append message' }, { status: 500 });
	}
};
