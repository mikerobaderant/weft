/**
 * Pure helpers that compose the Weave Chat send/receive flow.
 *
 * These exist so the security-critical claims of the chat panel
 * (no plaintext secrets ever leave the browser, secrets always come
 * back in the editor source) can be verified by unit tests rather
 * than only by manual smoke. AiChatPanel.svelte is a thin Svelte
 * wrapper around them.
 */

import type { ProjectDefinition } from '$lib/types';
import { stripSensitiveFields, restoreSensitiveFields, type LostSecret } from '$lib/ai/sanitize';
import { applyWeftPatch } from '$lib/ai/weft-patch';

/** Result of preparing the outbound chat request body. The `projectContext`
 *  field is what gets posted to /api/ai/chat — it is guaranteed to have
 *  every sensitive field value stripped. */
export interface ChatRequestPayload {
	projectContext: string;
}

/** Build the outbound payload from the current editor state. The single
 *  exit path for `projectContext` is this function: tests asserting that
 *  no sensitive value reaches the wire only need to cover one call site. */
export function buildChatPayload(
	currentWeft: string,
	currentNodes: ProjectDefinition['nodes'],
): ChatRequestPayload {
	return {
		projectContext: stripSensitiveFields(currentWeft, currentNodes),
	};
}

/** Result of processing an inbound chat reply that contained a weft patch.
 *  `restored` is what should land in the editor; `errors` are unmatched
 *  SEARCH blocks; `lostSecrets` are sensitive values that couldn't be put
 *  back because the patch renamed or removed their nodes. */
export interface ChatResponseResult {
	restored: string;
	errors: string[];
	lostSecrets: LostSecret[];
}

/** Apply the model's weft-patch against the unsanitized source, then
 *  re-merge originally-populated sensitive values keyed on (nodeId,
 *  fieldKey). The order matters: applying first against `currentWeft`
 *  (not the sanitized view) preserves any non-sensitive content the
 *  model didn't touch, and the restore step puts secrets back over
 *  the empty values the model would otherwise have written. */
export function applyChatResponse(
	currentWeft: string,
	currentNodes: ProjectDefinition['nodes'],
	weftPatch: string,
): ChatResponseResult {
	const { patched, errors } = applyWeftPatch(currentWeft, weftPatch);
	const { restored, lostSecrets } = restoreSensitiveFields(patched, currentNodes);
	return { restored, errors, lostSecrets };
}
