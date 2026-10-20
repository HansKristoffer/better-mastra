// Test helper (not exported): stubs `fetch` with the `preconnect` Bun expects.
import { spyOn } from 'bun:test'

export type FetchCall = { url: string; init: RequestInit | undefined }

export function stubFetch(
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
	const calls: FetchCall[] = []
	const spy = spyOn(globalThis, 'fetch').mockImplementation(
		Object.assign(
			async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
				calls.push({ url: String(url), init })
				return handler(String(url), init)
			},
			{ preconnect: fetch.preconnect }
		)
	)
	const bodies = () =>
		calls.map(
			(call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>
		)
	return { calls, bodies, restore: () => spy.mockRestore() }
}

export function chatCompletion(
	content = 'ok',
	usage?: Record<string, unknown>
) {
	return {
		id: 'gen-1',
		model: 'm',
		created: 1,
		object: 'chat.completion',
		choices: [
			{
				index: 0,
				message: { role: 'assistant', content },
				finish_reason: 'stop'
			}
		],
		usage: usage ?? { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
	}
}
