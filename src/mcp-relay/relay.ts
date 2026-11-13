import {
	type CallToolResult,
	Client,
	type PriorDiscovery,
	ProtocolError,
	SdkHttpError,
	StreamableHTTPClientTransport,
	type Tool,
	UnauthorizedError
} from '@modelcontextprotocol/client'

/** How long one discovery may take in all, connecting and every `tools/list` page, before the host goes on without the remote. */
const DISCOVERY_TIMEOUT_MS = 5_000

/** After a failed discovery, how long the remote is left out before it is tried again. */
const RETRY_AFTER_MS = 30_000

/** How old a discovery may get before the next ask refreshes it in the background. */
const REFRESH_AFTER_MS = 10 * 60_000

const CLIENT_INFO = { name: 'better-mastra-mcp-relay', version: '1.0.0' }

export type McpRelayOptions<Caller> = {
	/** The remote's Streamable HTTP endpoint. */
	url: URL
	/** Put before every remote tool's name, so it cannot take a name the host already uses. */
	prefix?: string
	/**
	 * The headers that make one call act as `caller`, such as its
	 * `Authorization`. Read on every call; discovery sends none.
	 */
	headers: (
		caller: Caller
	) => Record<string, string> | Promise<Record<string, string>>
	/**
	 * The remote tools to offer, by the remote's name; all of them when left
	 * out. `as` names one on the host instead of `prefix` + its name, and
	 * `description` replaces the remote's.
	 */
	tools?: Readonly<Record<string, true | { as?: string; description?: string }>>
	/**
	 * Inputs the model never sees: removed from every listed schema (and its
	 * `required`), filled on each call from the caller, and sent only to a
	 * tool whose schema has them. A value of undefined leaves the input out.
	 */
	hiddenInputs?: Readonly<Record<string, (caller: Caller) => unknown>>
	/**
	 * Tools and instructions to offer before any discovery answered, such as
	 * the list the remote's SDK ships, under the remote's names. With them,
	 * `tools()` and `instructions()` never wait on the remote: discovery runs
	 * in the background and replaces them once it answers.
	 */
	known?: { tools: Tool[]; instructions?: string }
	discovery?: {
		/** One discovery's whole deadline. Default 5 s. */
		timeoutMs?: number
		/** How long a remote that failed discovery is left out. Default 30 s. */
		retryAfterMs?: number
		/** How old a discovery gets before it is refreshed in the background. Default 10 minutes. */
		refreshAfterMs?: number
	}
	/**
	 * Told why discovery or a call failed, for the host's logs. It gets the
	 * error and the relayed tool's name, never the call's arguments or result.
	 */
	onError?: (error: unknown, event: McpRelayErrorEvent) => void
}

export type McpRelayErrorEvent =
	{ phase: 'discovery' } | { phase: 'call'; tool: string }

/** A remote MCP server's tools, offered under the host's own server and called as the host's caller. */
export type McpRelay<Caller> = {
	/** The remote's tools under their relayed names; empty while the remote cannot be reached and none are `known`. */
	tools: () => Promise<Tool[]>
	/** The remote's instructions as it sent them; `''` while it cannot be reached and none are `known`. */
	instructions: () => Promise<string>
	/** Starts discovery now, such as at boot, so no request waits for it. Never throws. */
	warm: () => void
	/**
	 * Calls a relayed tool as `caller`. A refused credential, a remote that
	 * is down and a remote error all come back as a tool error result; only
	 * an aborted call throws.
	 */
	callTool: (
		name: string,
		args: Record<string, unknown> | undefined,
		caller: Caller,
		options?: { signal?: AbortSignal }
	) => Promise<CallToolResult>
}

type Discovered = {
	tools: Tool[]
	/** Each relayed name's tool as the remote lists it. */
	remote: Map<string, Tool>
	instructions: string
	/** What a call's client starts from, so a modern remote answers it in one round trip; none for `known` tools. */
	prior: PriorDiscovery | undefined
}

/**
 * One remote MCP server, set up once per process. Nothing reaches the
 * remote until its tools, its instructions or a call are asked for (or
 * `warm()`); the first ask discovers them (`initialize` or
 * `server/discover`, then `tools/list`, with no caller's headers) within one
 * deadline. The process keeps the answer and refreshes it in the background
 * once it is old. A failed discovery leaves the remote out for 30 seconds
 * and is then tried again; `known` tools are offered meanwhile.
 */
export function createMcpRelay<Caller>(
	options: McpRelayOptions<Caller>
): McpRelay<Caller> {
	const prefix = options.prefix ?? ''
	const hiddenNames = Object.keys(options.hiddenInputs ?? {})
	const timeoutMs = options.discovery?.timeoutMs ?? DISCOVERY_TIMEOUT_MS
	const retryAfterMs = options.discovery?.retryAfterMs ?? RETRY_AFTER_MS
	const refreshAfterMs = options.discovery?.refreshAfterMs ?? REFRESH_AFTER_MS
	let live: Discovered | undefined
	let liveAt = 0
	let discovery: Promise<Discovered | null> | undefined
	let failedAt = Number.NEGATIVE_INFINITY

	const relayed = (
		listed: Tool[],
		instructions: string,
		prior: PriorDiscovery | undefined
	): Discovered => {
		const picked = listed.flatMap((tool) => {
			// Own keys only: a remote tool named `constructor` or `toString` is not on the list.
			const choice = !options.tools
				? true
				: Object.hasOwn(options.tools, tool.name) && options.tools[tool.name]
			if (!choice) return []
			const renamed = choice === true ? {} : choice
			const name = renamed.as ?? prefix + tool.name
			return [
				{
					remote: tool,
					offered: {
						...tool,
						name,
						...(renamed.description && { description: renamed.description }),
						inputSchema: withoutInputs(tool.inputSchema, hiddenNames)
					}
				}
			]
		})
		return {
			tools: picked.map(({ offered }) => offered),
			remote: new Map(
				picked.map(({ offered, remote }) => [offered.name, remote])
			),
			instructions,
			prior
		}
	}
	const known =
		options.known &&
		relayed(options.known.tools, options.known.instructions ?? '', undefined)

	const discover = () => {
		if (discovery) return discovery
		if (Date.now() - failedAt < retryAfterMs) return Promise.resolve(null)

		discovery = discoverRemote(options.url, timeoutMs).then(
			(found) => {
				discovery = undefined
				live = relayed(found.tools, found.instructions, found.prior)
				liveAt = Date.now()
				return live
			},
			(error: unknown) => {
				discovery = undefined
				failedAt = Date.now()
				options.onError?.(error, { phase: 'discovery' })
				return null
			}
		)
		return discovery
	}

	/** What the relay offers now: the newest discovery, refreshed when old, else `known`, else the first discovery. */
	const current = async (): Promise<Discovered | null> => {
		if (live) {
			if (Date.now() - liveAt >= refreshAfterMs) void discover()
			return live
		}
		if (known) {
			void discover()
			return known
		}
		return discover()
	}

	return {
		tools: async () => (await current())?.tools ?? [],
		instructions: async () => (await current())?.instructions ?? '',
		warm: () => void current(),
		callTool: async (name, args, caller, { signal } = {}) => {
			const discovered = await current()
			const tool = discovered?.remote.get(name)
			if (!discovered) return toolError(unreachableText(name))
			if (!tool) return toolError(`Unknown tool: ${name}`)

			let headers: Record<string, string>
			let input: Record<string, unknown> | undefined
			try {
				headers = await options.headers(caller)
				input = withHiddenInputs(args, tool, options.hiddenInputs, caller)
			} catch (error) {
				options.onError?.(error, { phase: 'call', tool: name })
				return toolError(
					`${name} failed: this caller's credentials could not be prepared.`
				)
			}

			const client = new Client(CLIENT_INFO, {
				versionNegotiation: { mode: 'auto' }
			})
			try {
				await client.connect(
					new StreamableHTTPClientTransport(options.url, {
						requestInit: { headers }
					}),
					{
						...(discovered.prior && { prior: discovered.prior }),
						...(signal && { signal })
					}
				)
				// Typed with the 2024 `toolResult` shape too; passed on as the remote sent it.
				return (await client.callTool(
					{ name: tool.name, ...(input && { arguments: input }) },
					{ toolDefinition: tool, ...(signal && { signal }) }
				)) as CallToolResult
			} catch (error) {
				if (signal?.aborted) throw error
				options.onError?.(error, { phase: 'call', tool: name })
				return toolError(failureText(name, error))
			} finally {
				await client.close().catch(() => {})
			}
		}
	}
}

/** One discovery, under one deadline for the connection and every page. */
async function discoverRemote(
	url: URL,
	timeoutMs: number
): Promise<{ tools: Tool[]; instructions: string; prior: PriorDiscovery }> {
	const client = new Client(CLIENT_INFO, {
		versionNegotiation: { mode: 'auto' }
	})
	const signal = AbortSignal.timeout(timeoutMs)
	const options = { signal, timeout: timeoutMs }
	const work = (async () => {
		await client.connect(new StreamableHTTPClientTransport(url), options)

		const listed: Tool[] = []
		let cursor: string | undefined
		do {
			const page = await client.listTools(cursor ? { cursor } : {}, options)
			listed.push(...page.tools)
			cursor = page.nextCursor
		} while (cursor)

		const discover = client.getDiscoverResult()
		return {
			tools: listed,
			instructions: client.getInstructions() ?? '',
			prior: discover
				? ({ kind: 'modern', discover } as const)
				: ({ kind: 'legacy' } as const)
		}
	})()
	try {
		// The deadline holds even for a transport that ignores the signal.
		return await Promise.race([
			work,
			new Promise<never>((_, reject) =>
				signal.addEventListener('abort', () => reject(signal.reason), {
					once: true
				})
			)
		])
	} finally {
		work.catch(() => {})
		await client.close().catch(() => {})
	}
}

/** The schema without the hidden inputs, in `properties` and in `required`. */
function withoutInputs(
	schema: Tool['inputSchema'],
	names: readonly string[]
): Tool['inputSchema'] {
	if (names.length === 0 || !schema?.properties) return schema
	const properties = Object.fromEntries(
		Object.entries(schema.properties).filter(([key]) => !names.includes(key))
	)
	const required = schema.required?.filter((key) => !names.includes(key))
	return {
		...schema,
		properties,
		...(required && { required })
	}
}

/** The model's arguments with the hidden inputs replaced by the caller's, for the inputs this tool's schema has. */
function withHiddenInputs<Caller>(
	args: Record<string, unknown> | undefined,
	tool: Tool,
	hidden: McpRelayOptions<Caller>['hiddenInputs'],
	caller: Caller
): Record<string, unknown> | undefined {
	if (!hidden) return args
	const names = Object.keys(hidden)
	const visible = Object.fromEntries(
		Object.entries(args ?? {}).filter(([key]) => !names.includes(key))
	)
	const listed = tool.inputSchema?.properties ?? {}
	const filled = Object.fromEntries(
		names.flatMap((key) => {
			if (!(key in listed)) return []
			const value = hidden[key]?.(caller)
			return value === undefined ? [] : [[key, value]]
		})
	)
	return { ...visible, ...filled }
}

function unreachableText(name: string) {
	return `${name} failed: the service behind it could not be reached. Try again in a moment.`
}

/** What the agent reads when a call failed: the tool's name and the HTTP status, never its arguments. */
function failureText(name: string, error: unknown) {
	const status = httpStatusOf(error)
	if (status === 401 || status === 403) {
		return `${name} was refused: the service behind it did not accept this caller's credentials (HTTP ${status}).`
	}
	if (status)
		return `${name} failed: the service behind it answered HTTP ${status}.`
	if (error instanceof ProtocolError) return error.message
	return unreachableText(name)
}

function httpStatusOf(error: unknown) {
	if (error instanceof UnauthorizedError) return 401
	if (error instanceof SdkHttpError) return error.status
	return undefined
}

function toolError(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true }
}
