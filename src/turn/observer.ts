/**
 * What one turn's UI-message stream says about itself: the outcome, the model
 * calls, the tool calls and how each settled, the time to the first answer
 * text, and the answer's own text. Only answer text counts as the first text:
 * reasoning and tool calls are the model working, and counting them made a
 * 70-second turn look like a 2-second one. A tool result carries only its call
 * id, so the name from the call is remembered across chunks.
 */

import { isMastraTimeoutError } from '@mastra/core/loop'
import type { UIMessageChunk } from 'ai'

import type { TurnStreamEnding } from './stream.js'

export type TurnOutcome =
	| 'answered'
	| 'stopped'
	| 'budget_stop'
	| 'timeout'
	| 'error'

export interface TurnSummary {
	readonly outcome: TurnOutcome
	/** Model calls, a retried call included. */
	readonly steps: number
	readonly toolCalls: number
	readonly timeToFirstTextMs: number | undefined
}

export interface ToolSettledEvent {
	readonly toolName: string
	readonly toolCallId: string
	readonly outcome: 'success' | 'error' | 'denied'
}

export interface TurnObserver {
	observe(chunk: UIMessageChunk): void
	/** An error Mastra reported. The last one decides between `timeout` and `error`. */
	failed(error: unknown): void
	summary(end: {
		readonly ending: TurnStreamEnding
		/** Whether the user stopped the turn: Mastra's own time limit aborts the run too. */
		readonly userStopped: boolean
	}): TurnSummary
	/** Everything the answer wrote, also when it waits for the user. */
	writtenText(): string
	/** The answer's text when replies may follow it; undefined when it waits for the user (a card, an approval, a client tool) or wrote nothing. */
	answerToFollow(): string | undefined
}

export function createTurnObserver(
	handlers: {
		/** Milliseconds since the turn started. */
		readonly elapsedMs?: () => number
		readonly onFirstText?: (elapsedMs: number) => void
		readonly onToolSettled?: (event: ToolSettledEvent) => void
	} = {}
): TurnObserver {
	const elapsedMs = handlers.elapsedMs ?? (() => 0)
	const names = new Map<string, string>()
	const waiting = new Set<string>()
	let steps = 0
	let toolCalls = 0
	let timeToFirstTextMs: number | undefined
	let text = ''
	let sawTripwire = false
	let sawError = false
	let waitsForApproval = false
	let lastErrorWasTimeout = false

	const settle = (toolCallId: string, outcome: ToolSettledEvent['outcome']) => {
		waiting.delete(toolCallId)
		handlers.onToolSettled?.({
			toolName: names.get(toolCallId) ?? 'unknown',
			toolCallId,
			outcome
		})
	}

	return {
		observe(chunk) {
			switch (chunk.type) {
				case 'start-step':
					steps += 1
					return
				case 'tool-input-start':
					names.set(chunk.toolCallId, chunk.toolName)
					return
				case 'tool-input-available':
					names.set(chunk.toolCallId, chunk.toolName)
					toolCalls += 1
					waiting.add(chunk.toolCallId)
					return
				case 'tool-output-available':
					// A preliminary output is an interim frame; the final one follows.
					if (chunk.preliminary !== true) settle(chunk.toolCallId, 'success')
					return
				case 'tool-output-error':
					settle(chunk.toolCallId, 'error')
					return
				case 'tool-output-denied':
					settle(chunk.toolCallId, 'denied')
					return
				case 'tool-approval-request':
					waitsForApproval = true
					return
				case 'text-delta':
					if (timeToFirstTextMs === undefined && chunk.delta.length > 0) {
						timeToFirstTextMs = elapsedMs()
						handlers.onFirstText?.(timeToFirstTextMs)
					}
					text += chunk.delta
					return
				case 'data-tripwire':
					sawTripwire = true
					return
				case 'error':
					sawError = true
					return
				default:
					return
			}
		},
		failed(error) {
			lastErrorWasTimeout = isMastraTimeoutError(error)
		},
		summary({ ending, userStopped }) {
			return {
				outcome: outcomeOf({
					wasStopped: userStopped || ending === 'cancelled',
					sawTripwire,
					sawError,
					lastErrorWasTimeout
				}),
				steps,
				toolCalls,
				timeToFirstTextMs
			}
		},
		writtenText: () => text,
		answerToFollow() {
			const answer = text.trim()
			const waitsForUser = waitsForApproval || waiting.size > 0

			return waitsForUser || answer.length === 0 ? undefined : answer
		}
	}
}

function outcomeOf(seen: {
	readonly wasStopped: boolean
	readonly sawTripwire: boolean
	readonly sawError: boolean
	readonly lastErrorWasTimeout: boolean
}): TurnOutcome {
	if (seen.wasStopped) return 'stopped'
	if (seen.sawTripwire) return 'budget_stop'
	if (seen.sawError) return seen.lastErrorWasTimeout ? 'timeout' : 'error'
	return 'answered'
}
