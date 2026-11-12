import { describe, expect, test } from 'bun:test'

import { createToolRefresh } from './cards.js'
import { pendingApproval } from './pending.js'

describe('createToolRefresh', () => {
	test('should refresh what the tool invalidates, and nothing for a read', () => {
		const manifest = {
			deal_move: { invalidates: ['deals', 'pipeline'] },
			deal_get: { invalidates: [] }
		} as const
		const refreshed: string[] = []
		const onToolResult = createToolRefresh(manifest, {
			deals: () => refreshed.push('deals'),
			pipeline: () => refreshed.push('pipeline')
		})

		onToolResult({ toolName: 'deal_get' })
		onToolResult({ toolName: 'deal_move' })
		onToolResult({ toolName: 'unknown' })

		expect(refreshed).toEqual(['deals', 'pipeline'])
	})
})

describe('pendingApproval', () => {
	test('should pick the approval a waiting turn waits for', () => {
		const approval = {
			kind: 'approval',
			runId: 'r',
			toolCallId: 'c',
			toolName: 'deal_move',
			approvalId: 'r::c',
			input: { stage: 'won' }
		} as const
		const suspended = {
			kind: 'suspended',
			runId: 'r2',
			toolCallId: 'c2',
			toolName: 'plan',
			payload: {}
		} as const

		expect(
			pendingApproval({ kind: 'waiting', changes: [suspended, approval] })
		).toBe(approval)
		expect(
			pendingApproval({ kind: 'waiting', changes: [suspended] })
		).toBeNull()
		expect(pendingApproval({ kind: 'idle' })).toBeNull()
	})
})
