/**
 * Issues Soniox temporary keys for client-side dictation: one REST call per
 * key. The account key never leaves the server; the client gets a single-use
 * key plus the region's WebSocket URL and model, so a model or region change
 * needs no app release.
 */

import { isRecord } from 'hanzio'

import type { DictationKey } from '../session.js'

/** Soniox's data-residency regions. Processing stays in a region only with that region's project key and host. */
export type SonioxRegion = 'us' | 'eu' | 'jp' | 'in'

export interface SonioxKeyUsage {
	readonly region: SonioxRegion
	readonly model: string
	readonly expiresAt: string
	readonly clientReferenceId?: string
}

export interface IssueSonioxTemporaryKeyOptions {
	/** The Soniox project's API key, for the chosen region. */
	readonly apiKey: string
	/** Defaults to `us`. */
	readonly region?: SonioxRegion
	/** The real-time model the client names in its start request. */
	readonly model?: string
	/** How long the client has to connect. */
	readonly expiresInSeconds?: number
	/** The longest one dictation may last. */
	readonly maxSessionDurationSeconds?: number
	/** Attributes the usage in Soniox's usage logs, e.g. a tenant id. Avoid personal data. */
	readonly clientReferenceId?: string
	/** Called after Soniox issued the key and before it is returned; a throw keeps the key from the client, so an unrecorded key is never used. */
	readonly onUsage?: (usage: SonioxKeyUsage) => void | Promise<void>
	readonly fetch?: typeof fetch
	/** The user is waiting with the microphone button pressed. */
	readonly timeoutMs?: number
}

/** Soniox answered with something other than an issued key. */
export class SonioxKeyError extends Error {
	constructor(readonly status: number) {
		super(`Soniox refused a temporary key with status ${status}.`)
		this.name = 'SonioxKeyError'
	}
}

export const SONIOX_DEFAULT_MODEL = 'stt-rt-v5'

const DEFAULT_EXPIRES_IN_SECONDS = 60
const DEFAULT_MAX_SESSION_SECONDS = 600
const DEFAULT_TIMEOUT_MS = 5_000
const ISSUED_STATUS = 201

/** The region's REST and real-time hosts. */
export function sonioxEndpoints(region: SonioxRegion = 'us'): {
	readonly temporaryKeyUrl: string
	readonly websocketUrl: string
} {
	const infix = region === 'us' ? '' : `.${region}`

	return {
		temporaryKeyUrl: `https://api${infix}.soniox.com/v1/auth/temporary-api-key`,
		websocketUrl: `wss://stt-rt${infix}.soniox.com/transcribe-websocket`
	}
}

/**
 * One single-use transcription key. A network failure or timeout throws as
 * `fetch` does; an answer other than a well-formed 201 throws `SonioxKeyError`.
 */
export async function issueSonioxTemporaryKey(
	options: IssueSonioxTemporaryKeyOptions
): Promise<Required<DictationKey>> {
	const region = options.region ?? 'us'
	const model = options.model ?? SONIOX_DEFAULT_MODEL
	const { temporaryKeyUrl, websocketUrl } = sonioxEndpoints(region)
	const response = await (options.fetch ?? fetch)(temporaryKeyUrl, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			usage_type: 'transcribe_websocket',
			expires_in_seconds:
				options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
			single_use: true,
			max_session_duration_seconds:
				options.maxSessionDurationSeconds ?? DEFAULT_MAX_SESSION_SECONDS,
			...(options.clientReferenceId === undefined
				? {}
				: { client_reference_id: options.clientReferenceId })
		}),
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
	})

	const issued =
		response.status === ISSUED_STATUS
			? parseIssuedKey(await response.json().catch(() => undefined))
			: undefined

	if (!issued) {
		throw new SonioxKeyError(response.status)
	}

	await options.onUsage?.({
		region,
		model,
		expiresAt: issued.expiresAt,
		...(options.clientReferenceId === undefined
			? {}
			: { clientReferenceId: options.clientReferenceId })
	})

	return { ...issued, websocketUrl, model }
}

function parseIssuedKey(
	body: unknown
): { apiKey: string; expiresAt: string } | undefined {
	if (!isRecord(body)) {
		return undefined
	}

	const { api_key: apiKey, expires_at: expiresAt } = body

	return typeof apiKey === 'string' &&
		apiKey !== '' &&
		typeof expiresAt === 'string' &&
		!Number.isNaN(Date.parse(expiresAt))
		? { apiKey, expiresAt }
		: undefined
}
