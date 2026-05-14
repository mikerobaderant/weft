import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import * as db from '$lib/server/db';
import { requireUserId } from '$lib/server/auth-locals';

export const GET = async (event: RequestEvent) => {
	const userId = requireUserId(event);
	try {
		await db.initDb();
		const chats = await db.listAiChats(event.params.id!, userId);
		return json(chats);
	} catch (error) {
		console.error('Failed to list chats:', error);
		return json({ error: 'Failed to list chats' }, { status: 500 });
	}
};

export const POST = async (event: RequestEvent) => {
	const userId = requireUserId(event);
	try {
		await db.initDb();
		const chat = await db.createAiChat(event.params.id!, userId);
		if (!chat) {
			return json({ error: 'Project not found' }, { status: 404 });
		}
		return json(chat, { status: 201 });
	} catch (error) {
		console.error('Failed to create chat:', error);
		return json({ error: 'Failed to create chat' }, { status: 500 });
	}
};
