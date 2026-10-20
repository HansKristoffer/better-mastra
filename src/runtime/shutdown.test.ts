import { expect, mock, test } from 'bun:test'
import { shutdown } from './shutdown'

function parts(failingFlush = false) {
	const order: string[] = []
	return {
		order,
		memory: { settled: mock(async () => void order.push('memory')) },
		mastra: {
			shutdown: mock(async () => {
				order.push('mastra')
				if (failingFlush) throw new Error('flush failed')
			})
		},
		storage: { close: mock(async () => void order.push('storage')) }
	}
}

test('lets memory work finish, then flushes observability, then closes the storage', async () => {
	const { order, ...input } = parts()
	await shutdown(input)
	expect(order).toEqual(['memory', 'mastra', 'storage'])
})

test('closes the storage even when the flush fails', async () => {
	const { order, ...input } = parts(true)
	await expect(shutdown(input)).rejects.toThrow('flush failed')
	expect(order).toEqual(['memory', 'mastra', 'storage'])
})

test('only closes the storage when nothing else was built', async () => {
	const { order, storage } = parts()
	await shutdown({ storage })
	expect(order).toEqual(['storage'])
})
