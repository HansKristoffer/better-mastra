import type { UIMessageChunk } from 'ai'

/**
 * The resumable stream registry the chat route hands a turn's stream to.
 * Declared here until `better-mastra/resumable` ships it; the shapes match.
 */
export interface ResumableStreams {
	start(input: {
		threadKey: string
		stream: ReadableStream<UIMessageChunk>
		abort: AbortController
	}): Promise<ReadableStream<UIMessageChunk>>
	/** The live tail of the thread's running turn; null when none runs (204). */
	reconnect(
		threadKey: string,
		signal?: AbortSignal
	): Promise<ReadableStream<UIMessageChunk> | null>
	stop(threadKey: string): Promise<boolean>
	close(): Promise<void>
}
