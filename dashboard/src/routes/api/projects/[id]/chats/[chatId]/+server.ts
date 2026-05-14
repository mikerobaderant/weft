import { json } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import * as db from '$lib/server/db';
import { requireUserId } from '$lib/server/auth-locals';

export const GET = async (event: RequestEvent) => {
	const userId = requireUserId(event);
	try {
		await db.initDb();
		const bundle = await db.getAiChatWithMessages(event.params.chatId!, userId);
		if (!bundle) return json({ error: 'Chat not found' }, { status: 404 });
		return json(bundle);
	} catch (error) {
		console.error('Failed to load chat:', error);
		return json({ error: 'Failed to load chat' }, { status: 500 });
	}
};

export const PATCH = async (event: RequestEvent) => {
	const userId = requireUserId(event);
	try {
		await db.initDb();
		const body = await event.request.json();
		if (typeof body.title !== 'string' || !body.title.trim()) {
			return json({ error: 'title is required' }, { status: 400 });
		}
		const chat = await db.updateAiChatTitle(event.params.chatId!, userId, body.title.trim().slice(0, 200));
		if (!chat) return json({ error: 'Chat not found' }, { status: 404 });
		return json(chat);
	} catch (error) {
		console.error('Failed to update chat:', error);
		return json({ error: 'Failed to update chat' }, { status: 500 });
	}
};

export const DELETE = async (event: RequestEvent) => {
	const userId = requireUserId(event);
	try {
		await db.initDb();
		const ok = await db.deleteAiChat(event.params.chatId!, userId);
		if (!ok) return json({ error: 'Chat not found' }, { status: 404 });
		return json({ ok: true });
	} catch (error) {
		console.error('Failed to delete chat:', error);
		return json({ error: 'Failed to delete chat' }, { status: 500 });
	}
};
