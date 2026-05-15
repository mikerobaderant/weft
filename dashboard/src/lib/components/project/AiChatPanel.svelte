<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { postChat, type ChatMessage } from '$lib/ai/chat-client';
	import { authFetch } from '$lib/config';
	import { stripSensitiveFields, restoreSensitiveFields } from '$lib/ai/sanitize';
	import { applyWeftPatch } from '$lib/ai/weft-patch';
	import type { ProjectDefinition } from '$lib/types';
	import { Send, AlertCircle, Plus, ChevronDown, Trash2, X, Copy, Check } from '@lucide/svelte';
	import { marked } from 'marked';

	const mdRenderer = new marked.Renderer();
	mdRenderer.link = ({ href, title, text }) => {
		const titleAttr = title ? ` title="${title}"` : '';
		return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
	};
	marked.setOptions({ breaks: true, gfm: true, renderer: mdRenderer });

	function renderMarkdown(text: string): string {
		return marked.parse(text, { async: false }) as string;
	}

	let {
		projectId,
		getCurrentWeft,
		onApplyWeft,
		config,
	}: {
		projectId: string;
		getCurrentWeft: () => { weft: string; nodes: ProjectDefinition['nodes'] };
		onApplyWeft: (weftCode: string) => Promise<void> | void;
		config?: { provider?: string; model?: string; apiKey?: string };
	} = $props();

	type ChatSummary = { id: string; title: string; updatedAt: string };
	type StoredMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string };

	// Provider context is windowed server-side (see
	// `routes/api/ai/chat/+server.ts`, env TANGLE_LITE_CONTEXT_TURNS).
	// UI shows the full conversation from the DB regardless.

	let chats = $state<ChatSummary[]>([]);
	let activeChatId = $state<string | null>(null);
	let messages = $state<StoredMessage[]>([]);
	let input = $state('');
	let sending = $state(false);
	let error = $state<string | null>(null);
	let booted = $state(false);
	let dropdownOpen = $state(false);
	let editingTitle = $state(false);
	let copiedId = $state<string | null>(null);
	let draftTitle = $state('');
	let scrollEl: HTMLElement | null = $state(null);

	$effect(() => {
		if (projectId && !booted) {
			boot();
		}
	});

	async function boot() {
		try {
			const list = await loadChats();
			if (list.length === 0) {
				const created = await createChat();
				if (created) {
					activeChatId = created.id;
					messages = [];
				}
			} else {
				activeChatId = list[0].id;
				await loadMessages(list[0].id);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			booted = true;
		}
	}

	async function loadChats(): Promise<ChatSummary[]> {
		const res = await authFetch(`/api/projects/${projectId}/chats`);
		if (!res.ok) throw new Error(`Failed to load chats: ${res.status}`);
		const list = (await res.json()) as ChatSummary[];
		chats = list;
		return list;
	}

	async function createChat(): Promise<ChatSummary | null> {
		const res = await authFetch(`/api/projects/${projectId}/chats`, { method: 'POST' });
		if (!res.ok) throw new Error(`Failed to create chat: ${res.status}`);
		const chat = (await res.json()) as ChatSummary;
		chats = [chat, ...chats];
		return chat;
	}

	async function loadMessages(chatId: string) {
		const res = await authFetch(`/api/projects/${projectId}/chats/${chatId}`);
		if (!res.ok) throw new Error(`Failed to load messages: ${res.status}`);
		const bundle = (await res.json()) as { chat: ChatSummary; messages: StoredMessage[] };
		messages = bundle.messages;
		scrollToBottom();
	}

	async function appendMessage(role: 'user' | 'assistant', content: string): Promise<StoredMessage> {
		if (!activeChatId) throw new Error('No active chat');
		const res = await authFetch(`/api/projects/${projectId}/chats/${activeChatId}/messages`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ role, content }),
		});
		if (!res.ok) throw new Error(`Failed to save message: ${res.status}`);
		return (await res.json()) as StoredMessage;
	}

	async function setTitleFromFirstMessage(content: string) {
		const activeChat = chats.find((c) => c.id === activeChatId);
		if (!activeChat || activeChat.title !== 'New chat') return;
		const title = content.slice(0, 60).trim() || 'New chat';
		try {
			await patchTitle(title);
		} catch {
			// Non-fatal — keep default title.
		}
	}

	async function patchTitle(title: string) {
		if (!activeChatId) return;
		const res = await authFetch(`/api/projects/${projectId}/chats/${activeChatId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title }),
		});
		if (!res.ok) throw new Error(`Failed to rename: ${res.status}`);
		const updated = (await res.json()) as ChatSummary;
		chats = chats.map((c) => (c.id === updated.id ? updated : c));
	}

	async function switchChat(chatId: string) {
		dropdownOpen = false;
		if (chatId === activeChatId) return;
		activeChatId = chatId;
		await loadMessages(chatId);
	}

	async function newChat() {
		dropdownOpen = false;
		const created = await createChat();
		if (created) {
			activeChatId = created.id;
			messages = [];
		}
	}

	async function deleteChat(chatId: string, ev: Event) {
		ev.stopPropagation();
		const res = await authFetch(`/api/projects/${projectId}/chats/${chatId}`, { method: 'DELETE' });
		if (!res.ok) {
			error = 'Failed to delete chat';
			return;
		}
		chats = chats.filter((c) => c.id !== chatId);
		if (chatId === activeChatId) {
			if (chats.length > 0) {
				activeChatId = chats[0].id;
				await loadMessages(chats[0].id);
			} else {
				const created = await createChat();
				if (created) {
					activeChatId = created.id;
					messages = [];
				}
			}
		}
	}

	async function send() {
		const trimmed = input.trim();
		if (!trimmed || sending || !activeChatId) return;

		error = null;
		const userMsg: StoredMessage = {
			id: crypto.randomUUID(),
			role: 'user',
			content: trimmed,
			createdAt: new Date().toISOString(),
		};
		messages = [...messages, userMsg];
		input = '';
		sending = true;
		scrollToBottom();

		const isFirstMessage = messages.length === 1;

		try {
			// Persist user message first so a crash/reload mid-call doesn't lose it.
			try {
				await appendMessage('user', trimmed);
			} catch (e) {
				error = `Couldn't save your message: ${e instanceof Error ? e.message : String(e)}`;
				// Undo optimistic append since persistence failed.
				messages = messages.slice(0, -1);
				return;
			}

			if (isFirstMessage) {
				setTitleFromFirstMessage(trimmed);
			}

			const fullHistory: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));

			const { weft: currentWeft, nodes: currentNodes } = getCurrentWeft();
			const sanitizedWeft = stripSensitiveFields(currentWeft, currentNodes);

			const res = await postChat({
				messages: fullHistory,
				projectContext: sanitizedWeft,
				config,
			});

			const assistantMsg: StoredMessage = {
				id: crypto.randomUUID(),
				role: 'assistant',
				content: res.text,
				createdAt: new Date().toISOString(),
			};
			messages = [...messages, assistantMsg];
			scrollToBottom();

			try {
				await appendMessage('assistant', res.text);
			} catch (e) {
				// Non-fatal — UI already shows the message.
				console.warn('Failed to persist assistant reply:', e);
			}

			if (res.weftPatch) {
				try {
					const { patched, errors } = applyWeftPatch(currentWeft, res.weftPatch);
					const messages: string[] = [];
					if (errors.length > 0) {
						messages.push(`Some patch blocks didn't match:\n${errors.join('\n')}`);
					}
					// The model writes patches against the sanitized view, so any
					// SEARCH/REPLACE that touches a sensitive field would clobber
					// the real value with the stripped one. Re-merge the originals
					// keyed on (nodeId, fieldKey) before pushing to the editor.
					const { restored, lostSecrets } = restoreSensitiveFields(patched, currentNodes);
					if (lostSecrets.length > 0) {
						const list = lostSecrets
							.map((s) => `${s.nodeLabel} (${s.fieldKey})`)
							.join(', ');
						messages.push(
							`This patch renamed or removed nodes that held secrets — please re-enter: ${list}`,
						);
					}
					if (messages.length > 0) error = messages.join('\n\n');
					await onApplyWeft(restored);
				} catch (e) {
					error = `Parsed patch but couldn't apply: ${e instanceof Error ? e.message : String(e)}`;
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			sending = false;
		}
	}

	async function copyMessage(msg: StoredMessage) {
		try {
			await navigator.clipboard.writeText(msg.content);
			copiedId = msg.id;
			setTimeout(() => {
				if (copiedId === msg.id) copiedId = null;
			}, 1500);
		} catch (e) {
			error = `Couldn't copy: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function scrollToBottom() {
		requestAnimationFrame(() => {
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			send();
		}
	}

	function beginTitleEdit() {
		const activeChat = chats.find((c) => c.id === activeChatId);
		if (!activeChat) return;
		draftTitle = activeChat.title;
		editingTitle = true;
	}

	async function commitTitleEdit() {
		if (!editingTitle) return;
		editingTitle = false;
		const trimmed = draftTitle.trim();
		if (!trimmed) return;
		const activeChat = chats.find((c) => c.id === activeChatId);
		if (!activeChat || activeChat.title === trimmed) return;
		try {
			await patchTitle(trimmed);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	function onTitleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitTitleEdit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			editingTitle = false;
		}
	}

	let activeTitle = $derived(chats.find((c) => c.id === activeChatId)?.title ?? 'Loading…');
</script>

<div class="flex flex-col h-full bg-white">
	<!-- Top bar -->
	<div class="flex items-center gap-1 border-b border-zinc-200 px-2 py-1.5 bg-[#f9fafb]">
		<div class="relative flex-1 min-w-0">
			{#if editingTitle}
				<input
					type="text"
					bind:value={draftTitle}
					onblur={commitTitleEdit}
					onkeydown={onTitleKeydown}
					class="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-500"
				/>
			{:else}
				<button
					class="flex w-full items-center gap-1 rounded px-1.5 py-1 text-xs text-left hover:bg-zinc-200/60 transition-colors"
					onclick={() => (dropdownOpen = !dropdownOpen)}
					title="Switch chat"
				>
					<ChevronDown class="w-3 h-3 shrink-0 text-zinc-500" />
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<span
						class="truncate font-medium text-zinc-800"
						role="button"
						tabindex="-1"
						ondblclick={beginTitleEdit}
						title="Double-click to rename"
					>{activeTitle}</span>
				</button>
			{/if}

			{#if dropdownOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="absolute left-0 top-full z-20 mt-1 w-full rounded border border-zinc-200 bg-white shadow-lg max-h-64 overflow-y-auto"
					onmouseleave={() => (dropdownOpen = false)}
				>
					{#each chats as chat}
						<div class="group flex items-center gap-1 px-1.5 py-1">
							<button
								class="flex-1 min-w-0 rounded px-1.5 py-1 text-left text-xs hover:bg-zinc-100 {chat.id === activeChatId ? 'bg-zinc-100 font-medium' : ''}"
								onclick={() => switchChat(chat.id)}
							>
								<span class="block truncate">{chat.title}</span>
							</button>
							<button
								class="opacity-0 group-hover:opacity-100 shrink-0 rounded p-1 text-zinc-400 hover:bg-red-50 hover:text-red-600 transition"
								onclick={(e) => deleteChat(chat.id, e)}
								title="Delete chat"
							>
								<Trash2 class="w-3 h-3" />
							</button>
						</div>
					{:else}
						<div class="px-2 py-2 text-xs text-zinc-400">No chats</div>
					{/each}
				</div>
			{/if}
		</div>
		<Button size="sm" variant="ghost" onclick={newChat} title="New chat" class="shrink-0 h-7 px-2">
			<Plus class="w-3.5 h-3.5" />
		</Button>
	</div>

	<!-- Messages -->
	<div bind:this={scrollEl} class="flex-1 overflow-y-auto px-3 py-3 space-y-3">
		{#if !booted}
			<div class="text-xs text-zinc-400">Loading…</div>
		{:else if messages.length === 0}
			<div class="text-xs text-zinc-500 leading-relaxed">
				<p class="font-semibold text-zinc-700 mb-1">Tangle-lite</p>
				<p>Describe what you want to build or change. I'll patch your .weft program and apply the edits to the canvas.</p>
				<p class="mt-2 text-zinc-400">Try: "Add a Debug node wired to a Text node that says hello"</p>
			</div>
		{/if}

		{#each messages as msg (msg.id)}
			<div class="group flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
				<div class="relative max-w-[85%]">
					{#if msg.role === 'user'}
						<div class="rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words bg-zinc-800 text-white">
							{msg.content}
						</div>
					{:else}
						<div class="ai-md rounded-lg px-3 py-2 text-xs break-words bg-zinc-100 text-zinc-800">
							{@html renderMarkdown(msg.content)}
						</div>
					{/if}
					<button
						class="absolute top-1 {msg.role === 'user' ? 'left-1' : 'right-1'} opacity-0 group-hover:opacity-100 transition rounded p-1 {msg.role === 'user' ? 'text-zinc-300 hover:bg-zinc-700' : 'text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700'}"
						onclick={() => copyMessage(msg)}
						title={copiedId === msg.id ? 'Copied!' : 'Copy'}
						aria-label="Copy message"
					>
						{#if copiedId === msg.id}
							<Check class="w-3 h-3" />
						{:else}
							<Copy class="w-3 h-3" />
						{/if}
					</button>
				</div>
			</div>
		{/each}

		{#if sending}
			<div class="flex justify-start">
				<div class="bg-zinc-100 text-zinc-500 rounded-lg px-3 py-2 text-xs italic">Thinking…</div>
			</div>
		{/if}
	</div>

	{#if error}
		<div class="mx-3 mb-2 flex items-start gap-2 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
			<AlertCircle class="w-3.5 h-3.5 shrink-0 mt-0.5" />
			<span class="break-words flex-1">{error}</span>
			<button onclick={() => (error = null)} class="shrink-0 text-red-400 hover:text-red-600">
				<X class="w-3 h-3" />
			</button>
		</div>
	{/if}

	<!-- Input -->
	<div class="border-t border-zinc-200 p-2">
		<div class="flex gap-1.5">
			<textarea
				bind:value={input}
				onkeydown={onKeydown}
				disabled={sending || !booted}
				placeholder="Ask Tangle-lite..."
				rows="2"
				class="flex-1 resize-y min-h-[3.5rem] max-h-[50vh] overflow-x-hidden rounded border border-zinc-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-zinc-400 disabled:bg-zinc-50 disabled:text-zinc-400"
			></textarea>
			<Button
				size="sm"
				onclick={send}
				disabled={sending || !booted || !input.trim()}
				class="self-end"
			>
				<Send class="w-3.5 h-3.5" />
			</Button>
		</div>
	</div>
</div>

<style>
	/* Compact markdown styles for assistant bubbles. The parent bubble
	   already sets the text size/color; these rules only tune spacing,
	   borders, and fenced-code formatting so Claude's replies read well
	   in a narrow sidebar. */
	.ai-md :global(p) { margin: 0 0 0.5em; }
	.ai-md :global(p:last-child) { margin-bottom: 0; }
	.ai-md :global(h1),
	.ai-md :global(h2),
	.ai-md :global(h3),
	.ai-md :global(h4) {
		font-weight: 600;
		margin: 0.6em 0 0.3em;
		line-height: 1.25;
	}
	.ai-md :global(h1) { font-size: 1.05em; }
	.ai-md :global(h2) { font-size: 1em; }
	.ai-md :global(h3),
	.ai-md :global(h4) { font-size: 0.95em; }
	.ai-md :global(ul),
	.ai-md :global(ol) {
		margin: 0.25em 0 0.5em;
		padding-left: 1.25em;
	}
	.ai-md :global(li) { margin: 0.15em 0; }
	.ai-md :global(li > p) { margin: 0; }
	.ai-md :global(strong) { font-weight: 600; }
	.ai-md :global(em) { font-style: italic; }
	.ai-md :global(code) {
		background: rgba(0, 0, 0, 0.06);
		padding: 0.1em 0.3em;
		border-radius: 3px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.9em;
	}
	.ai-md :global(pre) {
		background: #1f2937;
		color: #f3f4f6;
		padding: 0.5em 0.6em;
		border-radius: 4px;
		overflow-x: auto;
		margin: 0.4em 0;
		font-size: 0.85em;
		line-height: 1.4;
	}
	.ai-md :global(pre code) {
		background: transparent;
		padding: 0;
		color: inherit;
		font-size: 1em;
	}
	.ai-md :global(a) {
		color: #2563eb;
		text-decoration: underline;
	}
	.ai-md :global(blockquote) {
		border-left: 2px solid #d4d4d8;
		padding-left: 0.6em;
		color: #52525b;
		margin: 0.4em 0;
	}
	.ai-md :global(hr) {
		border: 0;
		border-top: 1px solid #e4e4e7;
		margin: 0.6em 0;
	}
</style>
