import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import { defineClientAction } from './actions'
import { createCardRegistry } from './cards'
import type { ToolPart } from './messages'
import { createOptimisticRatings } from './ratings'
import { createScreenContextStack } from './screen-context'

const part = (toolName: string, state: string, output?: unknown): ToolPart =>
	({
		type: 'dynamic-tool',
		toolName,
		toolCallId: `${toolName}-call`,
		state,
		input: {},
		output
	}) as ToolPart

describe('createCardRegistry', () => {
	const registry = createCardRegistry({
		schemas: { goals: z.object({ goals: z.array(z.string()) }) },
		toolCard: (toolName) =>
			(
				({ listGoals: 'goals', memory: 'silent', search: 'generic' }) as Record<
					string,
					'goals' | 'silent' | 'generic'
				>
			)[toolName],
		select: (output) => (output as { projection?: unknown }).projection,
		steps: { goals: false }
	})

	test('draws the typed card when the output fits, the generic row when it does not', () => {
		expect(
			registry.resolve(
				part('listGoals', 'output-available', {
					projection: { goals: ['Bil'] }
				})
			)
		).toMatchObject({
			kind: 'goals',
			state: 'done',
			data: { goals: ['Bil'] }
		})
		expect(
			registry.resolve(
				part('listGoals', 'output-available', { projection: { goals: 1 } })
			)
		).toMatchObject({
			kind: 'generic',
			toolName: 'listGoals'
		})
		expect(
			registry.resolve(part('listGoals', 'input-available'))
		).toMatchObject({ kind: 'goals', state: 'running' })
		expect(
			registry.resolve(part('unknownTool', 'output-available', {}))
		).toMatchObject({ kind: 'generic' })
		expect(
			registry.resolve(part('memory', 'output-available', {}))
		).toMatchObject({ kind: 'silent' })
	})

	test('folds runs of steps into one group and leaves silent tools out', () => {
		const folded = registry.fold([
			part('search', 'output-available', {}),
			part('memory', 'output-available', {}),
			part('unknownTool', 'output-available', {}),
			part('listGoals', 'output-available', { projection: { goals: [] } }),
			part('search', 'input-available')
		])

		expect(
			folded.map((item) =>
				item.kind === 'steps' ? `steps:${item.cards.length}` : item.card.kind
			)
		).toEqual(['steps:2', 'goals', 'steps:1'])
	})
})

describe('createScreenContextStack', () => {
	test('reads the screen focused last, pins it, and lets a chat tab be about no screen', () => {
		const stack = createScreenContextStack<string>()
		const action = defineClientAction({
			name: 'save',
			description: 'Save',
			inputSchema: z.object({}),
			handler: async () => undefined
		})
		let budget = 'Budget: 100'

		stack.focus('home', { read: () => 'Home' })
		stack.focus('budget', { read: () => budget, actions: [action] })
		stack.focus('home', { read: () => 'Home' })

		expect(stack.read()).toBe('Home')

		stack.leave('home')

		expect(stack.read()).toBe('Budget: 100')
		expect(stack.actions()).toEqual([action])

		stack.pinTop()
		budget = 'Budget: 200'
		stack.leave('budget')

		expect(stack.read()).toBe('Budget: 100')

		stack.unpin()
		stack.focusNone('chat-tab')

		expect(stack.read()).toBeUndefined()
		expect(stack.actions()).toEqual([])
	})
})

describe('createOptimisticRatings', () => {
	test('shows a rating at once and rolls it back when the server does not take it', async () => {
		type Rating = { messageId: string; rating: 'up' | 'down' }
		const stored: Rating[] = [{ messageId: 'a1', rating: 'up' }]
		let take = true
		const ratings = createOptimisticRatings<Rating>(async () => take)

		ratings.rate({ messageId: 'a1', rating: 'down' })

		expect(ratings.get(stored).get('a1')?.rating).toBe('down')

		take = false
		ratings.rate({ messageId: 'a2', rating: 'up' })
		await Promise.resolve()
		await Promise.resolve()

		expect(ratings.get(stored).get('a1')?.rating).toBe('down')
		expect(ratings.get(stored).has('a2')).toBe(false)
		expect(ratings.get(stored)).toBe(ratings.get(stored))
	})
})
