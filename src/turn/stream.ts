/**
 * A turn's stream on its way to the client: only user-facing parts, every
 * error as one fixed sentence, and each chunk shown to the turn first.
 * Mastra's stream is read to its end whether or not the client still reads,
 * so the turn's closing work (the thread lock's release) runs when the run has
 * really ended, Stop and a gone client included, and before the client sees
 * the stream close. After the closing work an epilogue may add parts of its
 * own, such as the replies offered after the answer, before the answer's finish.
 */

import type { UIMessage, UIMessageChunk } from 'ai'

/** How the stream ended for the client: read to the end, or the client went away first. */
export type TurnStreamEnding = 'finished' | 'cancelled'

export interface UserFacingStreamHandlers {
	/** Sees every chunk Mastra sends, including those the client never gets. */
	observe?(chunk: UIMessageChunk): void
	/** Runs once, when Mastra's stream has ended and before the client sees it close. */
	close?(ending: TurnStreamEnding): Promise<void>
	/** Sent right after the answer's `start`, such as the user's message for a client that reattaches. */
	afterStart?: UIMessageChunk
	/** Runs after `close` while the client still reads, before the answer's finish; it must not throw. */
	epilogue?(send: (chunk: UIMessageChunk) => void): Promise<void>
	/** The only error text the client receives. */
	errorSentence?: string
	onInternalError?(error: unknown): void
}

type SourceRead =
	| { readonly kind: 'chunk'; readonly chunk: UIMessageChunk }
	| { readonly kind: 'done' }
	| { readonly kind: 'failed'; readonly error: unknown }

/** The default only error text a client receives; the real error stays in the server log. */
export const TURN_ERROR_SENTENCE =
	'The assistant could not answer right now. Please try again.'

/**
 * The transient part that carries the turn's user message, right after the
 * answer's start. Mastra stores the message when the run ends, so a client
 * that reattaches mid-answer reads the question from here.
 */
export const USER_MESSAGE_PART = 'data-user-message'

/** Observational memory stores its own bookkeeping as `data-om-*` parts. */
const OBSERVATIONAL_MEMORY_PART_PREFIX = 'data-om-'

/** Whether a message part or chunk may reach the client: observational memory's may not. */
export function isUserFacingPart(part: { readonly type: string }): boolean {
	return !part.type.startsWith(OBSERVATIONAL_MEMORY_PART_PREFIX)
}

/** The message with only its user-facing parts. */
export function toUserFacingMessage<T extends UIMessage>(message: T): T {
	return { ...message, parts: message.parts.filter(isUserFacingPart) }
}

/** The stream the client receives for one turn. */
export function toUserFacingStream(
	source: ReadableStream<UIMessageChunk>,
	handlers: UserFacingStreamHandlers = {}
): ReadableStream<UIMessageChunk> {
	const errorChunk: UIMessageChunk = {
		type: 'error',
		errorText: handlers.errorSentence ?? TURN_ERROR_SENTENCE
	}
	const report = handlers.onInternalError ?? defaultReport
	let clientGone = false

	return new ReadableStream<UIMessageChunk>({
		start(controller) {
			const send = (chunk: UIMessageChunk) => {
				if (!clientGone) controller.enqueue(chunk)
			}
			const ending = (): TurnStreamEnding =>
				clientGone ? 'cancelled' : 'finished'

			pump(source, handlers, send, ending, errorChunk, report)
				.catch(report)
				.finally(() => {
					if (!clientGone) controller.close()
				})
		},
		cancel() {
			clientGone = true
		}
	})
}

async function pump(
	source: ReadableStream<UIMessageChunk>,
	handlers: UserFacingStreamHandlers,
	send: (chunk: UIMessageChunk) => void,
	ending: () => TurnStreamEnding,
	errorChunk: UIMessageChunk,
	report: (error: unknown) => void
): Promise<void> {
	// The answer's finish waits for the epilogue, so its parts belong to the answer.
	let finish: UIMessageChunk | undefined
	let { afterStart } = handlers
	const reader = source.getReader()
	let next = await readNext(reader)

	while (next.kind === 'chunk') {
		handlers.observe?.(next.chunk)

		if (next.chunk.type === 'finish' && handlers.epilogue) {
			finish = next.chunk
		} else if (isUserFacingPart(next.chunk)) {
			send(next.chunk.type === 'error' ? errorChunk : next.chunk)

			if (next.chunk.type === 'start' && afterStart) {
				send(afterStart)
				afterStart = undefined
			}
		}

		next = await readNext(reader)
	}

	if (next.kind === 'failed') {
		report(next.error)
		handlers.observe?.(errorChunk)
		send(errorChunk)
	}

	await handlers.close?.(ending())

	if (handlers.epilogue && ending() === 'finished') {
		await handlers.epilogue(send)
	}

	if (finish) send(finish)
}

async function readNext(reader: {
	read(): Promise<{ done: boolean; value?: UIMessageChunk | undefined }>
}): Promise<SourceRead> {
	try {
		const next = await reader.read()

		return next.done || next.value === undefined
			? { kind: 'done' }
			: { kind: 'chunk', chunk: next.value }
	} catch (error) {
		return { kind: 'failed', error }
	}
}

function defaultReport(error: unknown): void {
	// biome-ignore lint/suspicious/noConsole: the default logger, which apps replace.
	console.error('[better-mastra] the turn stream failed', error)
}
