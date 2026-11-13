import { describe, expect, test } from 'bun:test'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'

import {
	createHarness,
	DELETE_TOOL,
	readTurn,
	textReply,
	toolCallReply,
	userMessage
} from '../turn/turnFixtures.test.js'
import { createResumableStreams } from './index.js'
import { replayPrefixOf } from './replay.js'

function streamOf(
	chunks: readonly UIMessageChunk[]
): ReadableStream<UIMessageChunk> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk)
			controller.close()
		}
	})
}

/** The message a client builds from a stream, starting empty as a reconnect does. */
async function build(stream: ReadableStream<UIMessageChunk>) {
	let message: UIMessage | undefined

	for await (const built of readUIMessageStream({
		stream,
		terminateOnError: true
	})) {
		message = built
	}

	return message
}

/** A part as a card reads it: what it is, how far it came and what it holds. */
function shape(message: UIMessage | undefined) {
	return (message?.parts ?? []).map((part) => {
		const { type, state, text, input, output, errorText, approval, data } =
			part as Record<string, unknown>

		return JSON.parse(
			JSON.stringify({
				type,
				// A text part's `state` only says whether it still streams.
				state: type === 'text' || type === 'reasoning' ? undefined : state,
				text,
				input,
				output,
				errorText,
				approval,
				data
			})
		)
	})
}

const QUESTION = userMessage('Slet budgettet')

const ANSWER: UIMessage = {
	id: 'answer-1',
	role: 'assistant',
	parts: [
		{ type: 'step-start' },
		{ type: 'reasoning', text: 'Which budget?' },
		{ type: 'text', text: 'Jeg kigger.' },
		{
			type: 'tool-lookupSpending',
			toolCallId: 'call-read',
			state: 'output-available',
			input: { category: 'food' },
			output: { spent: 1250 }
		},
		{
			type: 'dynamic-tool',
			toolName: 'openScreen',
			toolCallId: 'call-screen',
			state: 'output-error',
			input: { screen: 'budget' },
			errorText: 'No such screen.'
		},
		{ type: 'data-note', id: 'note-1', data: { shown: true } },
		{ type: 'step-start' },
		{
			type: 'tool-deleteBudget',
			toolCallId: 'call-write',
			state: 'approval-responded',
			input: { budgetId: 'b-1' },
			approval: { id: 'run-1::call-write', approved: true }
		},
		{
			type: 'tool-renameBudget',
			toolCallId: 'call-denied',
			state: 'output-denied',
			input: { budgetId: 'b-2' },
			approval: { id: 'run-1::call-denied', approved: false, reason: 'Nej' }
		}
	]
}

describe('replayPrefixOf', () => {
	test('rebuilds the answer a request continues, part by part', async () => {
		const prefix = replayPrefixOf([QUESTION, ANSWER])
		const rebuilt = await build(
			streamOf([{ type: 'start', messageId: 'answer-1' }, ...prefix])
		)

		expect(shape(rebuilt)).toEqual(shape(ANSWER))
	})

	test('never sends a call that has its result as one to carry out', () => {
		const prefix = replayPrefixOf([QUESTION, ANSWER])

		// `tool-input-available` is the chunk a client runs a client action on
		expect(
			prefix.filter((chunk) => chunk.type === 'tool-input-available')
		).toEqual([])
		expect(
			replayPrefixOf([
				{
					id: 'a',
					role: 'assistant',
					parts: [
						{
							type: 'tool-openScreen',
							toolCallId: 'call-1',
							state: 'input-available',
							input: { screen: 'budget' }
						}
					]
				}
			])
		).toEqual([
			{
				type: 'tool-input-available',
				toolCallId: 'call-1',
				toolName: 'openScreen',
				input: { screen: 'budget' }
			}
		])
	})

	test("is empty for a request that ends with the user's message", () => {
		expect(replayPrefixOf([ANSWER, QUESTION])).toEqual([])
		expect(replayPrefixOf([])).toEqual([])
	})
})

describe('a reconnect to a turn that goes on after an approval', () => {
	test('replays the whole answer, which the turn alone cannot rebuild', async () => {
		// Given a real turn that proposes a change and waits for the user's approval
		const harness = createHarness({
			replies: [
				toolCallReply(DELETE_TOOL, { budgetId: 'b-1' }, 'call-1'),
				textReply('Slettet.')
			]
		})
		const proposed = (
			await readTurn(await harness.run({ messages: [QUESTION] }))
		).message
		const approved: UIMessage = {
			...proposed!,
			parts: proposed!.parts.map((part) =>
				'approval' in part && part.approval
					? ({
							...part,
							state: 'approval-responded',
							approval: { id: part.approval.id, approved: true }
						} as typeof part)
					: part
			)
		}

		// When the user approves, on a server that keeps the turn resumable
		const resumable = createResumableStreams({})
		const messages = [QUESTION, approved]
		const turn = await harness.run({ messages })

		if (turn.kind !== 'stream') throw new Error('The turn was refused.')

		const live = await Array.fromAsync(
			await resumable.start({
				threadKey: turn.threadKey.threadId,
				stream: turn.stream,
				abort: new AbortController(),
				replayPrefix: replayPrefixOf(messages)
			})
		)

		// Then the request that started the turn gets only what the turn adds:
		// it opens on the result of a call an earlier request made
		const opening = live.find(
			(chunk) => chunk.type !== 'start' && !chunk.type.startsWith('data-')
		)
		expect(opening).toMatchObject({
			type: 'tool-output-available',
			toolCallId: 'call-1'
		})
		expect(live[0]).toEqual({ type: 'start', messageId: approved.id })
		await expect(build(streamOf(live))).rejects.toThrow()

		// And a reconnecting client, which starts empty, gets the whole answer
		const replayed = await build(
			(await resumable.reconnect(turn.threadKey.threadId))!
		)
		const continued = await Array.fromAsync(
			readUIMessageStream({ message: approved, stream: streamOf(live) })
		)

		expect(shape(replayed)).toEqual(shape(continued.at(-1)))
		expect(JSON.stringify(shape(replayed))).toContain('Slettet.')
		expect(
			shape(replayed).find((part) => part.type === `tool-${DELETE_TOOL}`)
		).toMatchObject({ state: 'output-available', input: { budgetId: 'b-1' } })

		await resumable.close()
	})
})
