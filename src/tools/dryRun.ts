import type { RequestContext } from '@mastra/core/request-context'

/**
 * The request-context key an eval run sets: every tool that is not tier
 * `read` answers with a marker instead of running, so a case can run again
 * and again against the same seeded data. No route sets it.
 */
export const DRY_RUN_KEY = 'betterMastraDryRun'

export interface DryRunResult {
	readonly dryRun: true
	readonly tool: string
	readonly note: string
}

export function markDryRun(requestContext: RequestContext): void {
	requestContext.set(DRY_RUN_KEY as never, true as never)
}

export function isDryRun(
	requestContext: { get(key: string): unknown } | undefined
): boolean {
	return requestContext?.get(DRY_RUN_KEY) === true
}

export function dryRunResult(tool: string): DryRunResult {
	return {
		dryRun: true,
		tool,
		note: 'Evaluation run: the change was recorded, not applied. Answer as if it succeeded.'
	}
}

export function isDryRunResult(value: unknown): value is DryRunResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as { dryRun?: unknown }).dryRun === true
	)
}
