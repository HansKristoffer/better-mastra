import { withSseHeartbeat } from '@mastra/ai-sdk'
import { createUIMessageStreamResponse, type UIMessageChunk } from 'ai'

/** Keep-alive comments while the stream is idle, so proxies keep the connection open. */
export const SSE_HEARTBEAT_MS = 15_000

/**
 * The UI-message stream as an SSE response with Mastra's heartbeat, and the
 * headers that stop proxies (nginx, Railway) from buffering it.
 */
export function toChatStreamResponse(
	stream: ReadableStream<UIMessageChunk>,
	heartbeatMs = SSE_HEARTBEAT_MS
): Response {
	return withSseHeartbeat(
		createUIMessageStreamResponse({
			stream,
			headers: { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }
		}),
		heartbeatMs
	)
}
