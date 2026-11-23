import { type Logger, silentLogger } from '../models/route.js'

/**
 * Shuts Mastra down in the order its parts depend on each other: resumable
 * streams drain first (if given), then memory work (observations, extractions)
 * finishes, then Mastra's own shutdown flushes observability and drains durable
 * runs, then the storage closes. The storage closes even when an earlier step
 * fails.
 */
export async function shutdown(input: {
	resumable?: { close: () => Promise<void> }
	mastra?: { shutdown: (options?: { drainTimeout?: number }) => Promise<void> }
	memory?: { settled: () => Promise<void> }
	storage?: { close: () => Promise<void> }
	drainTimeout?: number
	logger?: Logger
}) {
	const logger = input.logger ?? silentLogger
	try {
		await input.resumable?.close()
		await input.memory?.settled()
		await input.mastra?.shutdown(
			input.drainTimeout === undefined
				? undefined
				: { drainTimeout: input.drainTimeout }
		)
	} finally {
		await input.storage?.close()
		logger.info('Mastra shut down', {
			...(input.resumable && { resumable_closed: true }),
			memory_settled: Boolean(input.memory),
			observability_flushed: Boolean(input.mastra),
			storage_closed: Boolean(input.storage)
		})
	}
}
