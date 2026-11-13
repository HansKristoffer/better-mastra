import { describe, expect, test } from 'bun:test'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'

import { defineModelArms, threadBucket } from './modelArms.js'
import { measurePromptBudget } from './promptBudget.js'
import { promptVersion } from './promptVersion.js'
import { deriveThreadTitle } from './title.js'
import type { TurnFinishedEvent } from './runChatTurn.js'
import {
	createHarness,
	readTurn,
	type Scope,
	textReply,
	userMessage
} from './turnFixtures.test.js'

const arms = defineModelArms({
	arms: { default: { modelId: 'big' }, fast: { modelId: 'small' } },
	assign: ({ threadId }: { threadId: string; onSpecialistPage: boolean }) =>
		threadBucket(threadId) < 0.5 ? 'fast' : 'default'
})

describe('defineModelArms', () => {
	test("should keep the stored arm for the thread's life and assign only a new thread", () => {
		const fresh = arms.resolve({
			threadId: 't-1',
			onSpecialistPage: true,
			metadata: {}
		})
		const kept = arms.resolve({
			threadId: 't-1',
			onSpecialistPage: false,
			metadata: { modelArm: fresh.name === 'fast' ? 'default' : 'fast' }
		})

		expect(fresh.modelId).toBe(arms.arms[fresh.name].modelId)
		expect(kept.name).not.toBe(fresh.name)
		expect(arms.stored({ modelArm: 'gone' })).toBeNull()
	})
})

describe('promptVersion', () => {
	test('should change with the copy and the tools, never with their order', () => {
		const tools = [
			{ name: 'b', tier: 'read', description: 'B' },
			{ name: 'a', tier: 'approval', description: 'A' }
		]
		const version = promptVersion({ sections: ['Be brief.'], tools })

		expect(version).toHaveLength(12)
		expect(
			promptVersion({ sections: ['Be brief.'], tools: [...tools].reverse() })
		).toBe(version)
		expect(promptVersion({ sections: ['Be briefer.'], tools })).not.toBe(
			version
		)
	})
})

describe('measurePromptBudget', () => {
	test('should count the instructions and every tool schema the model gets', async () => {
		const budget = await measurePromptBudget({
			instructions: 'x'.repeat(100),
			signal: 'now',
			tools: {
				lookup: createTool({
					id: 'lookup',
					description: 'Looks up spending.',
					inputSchema: z.object({ category: z.string() })
				})
			}
		})

		expect(budget.instructionsChars).toBe(100)
		expect(budget.perRequestChars).toBe(3)
		expect(budget.toolChars.lookup).toBeGreaterThan(40)
		expect(budget.cachedPrefixChars).toBe(100 + budget.toolSchemaChars)
	})

	test('should count every stable instruction block', async () => {
		const budget = await measurePromptBudget({
			instructions: ['x'.repeat(100), 'y'.repeat(20)]
		})

		expect(budget.instructionsChars).toBe(120)
		expect(budget.cachedPrefixChars).toBe(120)
	})
})

describe('deriveThreadTitle', () => {
	test('should cut the first user message to six words', () => {
		expect(
			deriveThreadTitle([
				userMessage('  Hvor   meget har vi brugt på mad i år?')
			])
		).toBe('Hvor meget har vi brugt på…')
		expect(deriveThreadTitle([])).toBeNull()
	})
})

describe('the turn metadata and scoring', () => {
	test('should store the arm on the thread, keep the title and score the answered turn with its labels', async () => {
		const scored: TurnFinishedEvent<Scope>[] = []
		const harness = createHarness({
			replies: [textReply('Hej!')],
			overrides: { sinks: { scoreTurn: (event) => scored.push(event) } }
		})
		const prepare = harness.deps.prepare
		harness.deps.prepare = async (input) => {
			const arm = arms.resolve({
				threadId: input.threadKey.threadId,
				onSpecialistPage: false,
				metadata: input.thread?.metadata
			})
			return {
				...(await prepare(input)),
				threadMetadata: { modelArm: arm.name, promptVersion: 'v1' },
				labels: { arm: arm.name, promptVersion: 'v1' }
			}
		}

		const first = userMessage('Første spørgsmål')
		const firstTurn = await readTurn(await harness.run({ messages: [first] }))
		await readTurn(
			await harness.run({
				messages: [first, firstTurn.message!, userMessage('Andet')]
			})
		)

		const thread = await harness.memory.getThreadById({
			threadId: harness.threadKey.threadId
		})
		expect(thread?.title).toBe('Første spørgsmål')
		expect(thread?.metadata).toMatchObject({
			modelArm: scored[0]?.labels.arm,
			promptVersion: 'v1'
		})
		expect(scored).toHaveLength(2)
		expect(scored[1]?.labels.arm).toBe(scored[0]?.labels.arm)
	})

	test('should read the thread again after the answer only when it has a title or a value to write', async () => {
		// Given a turn that counts the thread reads made after it finished
		const countReadsAfterFinish = async (
			overrides: Parameters<typeof createHarness>[0],
			turns: number
		) => {
			let reads = 0
			let readsAtFinish = 0
			const harness = createHarness({
				...overrides,
				overrides: {
					...overrides?.overrides,
					sinks: {
						turnFinished: () => {
							readsAtFinish = reads
						}
					}
				}
			})
			const read = harness.memory.getThreadById.bind(harness.memory)
			harness.memory.getThreadById = (args) => {
				reads += 1

				return read(args)
			}
			const messages = [userMessage('Første')]

			for (let turn = 0; turn < turns; turn += 1) {
				const { message } = await readTurn(await harness.run({ messages }))
				messages.push(message!, userMessage('Næste'))
			}

			return reads - readsAtFinish
		}

		// A turn without a title or metadata reads nothing after the answer
		expect(
			await countReadsAfterFinish({ overrides: { deriveTitle: false } }, 1)
		).toBe(0)
		// A new thread gets its title, which takes the read
		expect(await countReadsAfterFinish({}, 1)).toBe(1)
		// A thread that has its title needs nothing more
		expect(await countReadsAfterFinish({}, 2)).toBe(0)
	})
})
