import { type UIMessage, validateUIMessages } from 'ai'
import type { z } from 'zod'

/**
 * A request body parsed with the app's schema, its messages then checked
 * part by part with the AI SDK's `validateUIMessages`; `chatTurnBodySchema`
 * checks only their shape. Undefined for a body that fails either, which
 * `createChatRoute`'s `parseBody` answers with `invalid_request`.
 *
 * The app's schema is `chatTurnBodySchema` with zod's own `omit` and
 * `extend`: without `threadId` where the server derives the thread, with its
 * own fields, a cap on `messages`, or `resume` typed by its own data.
 */
export async function parseChatTurnBody<
	TBody extends { messages: readonly UIMessage[] }
>(schema: z.ZodType<TBody>, json: unknown): Promise<TBody | undefined> {
	const parsed = schema.safeParse(json)

	if (!parsed.success) return undefined

	try {
		const messages = await validateUIMessages({
			messages: parsed.data.messages
		})

		return { ...parsed.data, messages }
	} catch {
		return undefined
	}
}
