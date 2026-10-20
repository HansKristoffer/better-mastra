import { type Logger, silentLogger } from '../models/route.js'

/** `up`/`down` for a pinged dependency, `configured`/`not_configured` for one checked by its key. */
export type DependencyStatus = 'up' | 'down' | 'configured' | 'not_configured'

export type DependencyHealth = {
	readonly dependency: string
	/** A turn fails without it; the others only switch a feature off. */
	readonly required: boolean
	readonly status: DependencyStatus
	/** For `down`: the error's code, or its name when it has none. */
	readonly detail?: string
}

export type Health = {
	readonly checkedAt: string
	/** Every required dependency is up or configured. */
	readonly healthy: boolean
	readonly dependencies: readonly DependencyHealth[]
}

export type DependencyCheck = {
	/** False when its connection or key is missing: reported without a ping. */
	readonly configured: boolean
	/** Pinged when configured; without it a configured dependency is just `configured`. */
	readonly ping?: () => Promise<void>
	/** Defaults to true. */
	readonly required?: boolean
}

/**
 * Checks every dependency at once: stores are pinged, providers and
 * integrations only checked for their key, so a check spends no tokens and
 * calls no vendor. A failed ping is a `down` row naming the error's code,
 * never its message or a key; the detail goes to the log.
 */
export async function checkHealth(input: {
	checks: Readonly<Record<string, DependencyCheck>>
	now?: () => Date
	logger?: Logger
}): Promise<Health> {
	const logger = input.logger ?? silentLogger
	const dependencies = await Promise.all(
		Object.entries(input.checks).map(
			async ([dependency, check]): Promise<DependencyHealth> => {
				const required = check.required ?? true
				if (!check.configured)
					return { dependency, required, status: 'not_configured' }
				if (!check.ping) return { dependency, required, status: 'configured' }
				try {
					await check.ping()
					return { dependency, required, status: 'up' }
				} catch (error) {
					const { code, name, message } = (error ?? {}) as {
						code?: unknown
						name?: unknown
						message?: unknown
					}
					const detail = String(code ?? name ?? 'Error')
					logger.warn('A dependency is down', {
						dependency,
						code: detail,
						error_message: String(message)
					})
					return { dependency, required, status: 'down', detail }
				}
			}
		)
	)

	return {
		checkedAt: (input.now?.() ?? new Date()).toISOString(),
		healthy: dependencies.every(
			(row) =>
				!row.required || row.status === 'up' || row.status === 'configured'
		),
		dependencies
	}
}
