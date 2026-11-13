/**
 * A turn's stream on its way to the client: only user-facing parts, every
 * error as one fixed sentence, and each chunk shown to the turn first.
 * Mastra's stream is read to its end whether or not the client still reads,
 * so the turn's closing work (the thread lock's release) runs when the run has
 * really ended, Stop and a gone client included, and before the client sees
 * the stream close. After the closing work an epilogue may add parts of its
 * own, such as the replies offered after the answer. They follow the answer's
 * `finish`, so the answer is never held for them; `holdFinish` keeps the
 * earlier order, where the finish waits for the epilogue.
 */

import type { UIMessageChunk } from 'ai'

import {
	isUserFacingPart,
	toUserFacingMessage,
	USER_MESSAGE_PART
} from '../protocol/index.js'

/** How the stream ended for the client: read to the end, or the client went away first. */
export type TurnStreamEnding = 'finished' | 'cancelled'

export interface UserFacingStreamHandlers {
	/** Sees every chunk Mastra sends, including those the client never gets. One that throws is reported and the stream goes on. */
	observe?(chunk: UIMessageChunk): void
	/** Runs once, when Mastra's stream has ended and before the client sees it close. One that fails is reported; the epilogue and the close still follow. */
	close?(ending: TurnStreamEnding): Promise<void>
	/** Sent right after the answer's `start`, such as the user's message for a client that reattaches. */
	afterStart?: UIMessageChunk
	/**
	 * Runs after `close` while the client still reads, and after the answer's
	 * `finish` was sent: its parts are transient extras, and the stream closes
	 * when it ends. It must not throw.
	 */
	epilogue?(send: (chunk: UIMessageChunk) => void): Promise<void>
	/**
	 * Holds the answer's `finish` until the epilogue has run, for a client
	 * that stops reading at `finish`. Default false.
	 */
	holdFinish?: boolean
	/** The only error text the client receives. */
	errorSentence?: string
	onInternalError?(error: unknown): void
}

type SourceRead =
	| { readonly kind: 'chunk'; readonly chunk: UIMessageChunk }
	| { readonly kind: 'done' }
	| { readonly kind: 'failed'; readonly error: unknown }

export { isUserFacingPart, toUserFacingMessage, USER_MESSAGE_PART }

/** The default only error text a client receives; the real error stays in the server log. */
export const TURN_ERROR_SENTENCE =
	'The assistant could not answer right now. Please try again.'

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
	// With `holdFinish`, the answer's finish waits for the epilogue.
	const holdsFinish = handlers.holdFinish === true && !!handlers.epilogue
	let finish: UIMessageChunk | undefined
	let { afterStart } = handlers
	// An observer that throws must not stop the read: the run would never be
	// read to its end, and the turn's closing work would never run.
	const observe = (chunk: UIMessageChunk) => {
		try {
			handlers.observe?.(chunk)
		} catch (error) {
			report(error)
		}
	}
	const reader = source.getReader()
	let next = await readNext(reader)

	while (next.kind === 'chunk') {
		observe(next.chunk)

		if (next.chunk.type === 'finish' && holdsFinish) {
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
		observe(errorChunk)
		send(errorChunk)
	}

	await handlers.close?.(ending()).catch(report)

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
