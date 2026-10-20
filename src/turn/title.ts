import type { MastraMemory } from '@mastra/core/memory'
import type { UIMessage } from 'ai'

import type { ThreadKey } from './types.js'

const TITLE_MAX_WORDS = 6
const TITLE_MAX_LENGTH = 64

/** The first user message's first six words, at most 64 characters, with `…` when cut; null without text. */
export function deriveThreadTitle(
	messages: readonly UIMessage[]
): string | null {
	const text = messages
		.find((message) => message.role === 'user')
		?.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim()

	if (!text) return null

	const words = text.split(' ')
	const wordLimited = words.slice(0, TITLE_MAX_WORDS).join(' ')
	const wasTruncated =
		words.length > TITLE_MAX_WORDS || wordLimited.length > TITLE_MAX_LENGTH
	const title = wordLimited.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()

	return wasTruncated ? `${title}…` : title
}

/**
 * Fills in what the caller's thread keeps from its turns: a title, when it has
 * none yet (a later turn never renames it), and the turn's metadata values
 * (its model arm, its prompt version) over the stored ones. Writes only when
 * something changed; returns whether it wrote.
 */
export async function persistThreadMetadata(input: {
	readonly memory: Pick<MastraMemory, 'getThreadById' | 'updateThread'>
	readonly key: ThreadKey
	readonly title?: string | null
	readonly metadata?: Readonly<Record<string, unknown>>
}): Promise<boolean> {
	const thread = await input.memory.getThreadById({
		threadId: input.key.threadId
	})

	if (!thread || thread.resourceId !== input.key.resourceId) return false

	const stored = thread.metadata ?? {}
	const storedTitle = thread.title?.trim()
	const title = storedTitle || input.title || ''
	const metadata = { ...stored, ...input.metadata }
	const changed =
		title !== (storedTitle ?? '') ||
		Object.entries(input.metadata ?? {}).some(
			([key, value]) => stored[key] !== value
		)

	if (!changed) return false

	await input.memory.updateThread({ id: thread.id, title, metadata })

	return true
}
