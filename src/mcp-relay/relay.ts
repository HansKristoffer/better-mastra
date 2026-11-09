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

/** How long discovery may take before the host goes on without the remote. */
const DISCOVERY_TIMEOUT_MS = 5_000

/** After a failed discovery, how long the remote is left out before it is tried again. */
const RETRY_AFTER_MS = 30_000

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
	 * Told why discovery or a call failed, for the host's logs. It gets the
	 * error and the relayed tool's name, never the call's arguments or result.
	 */
	onError?: (error: unknown, event: McpRelayErrorEvent) => void
}

export type McpRelayErrorEvent =
	{ phase: 'discovery' } | { phase: 'call'; tool: string }

/** A remote MCP server's tools, offered under the host's own server and called as the host's caller. */
export type McpRelay<Caller> = {
	/** The remote's tools under their relayed names; empty while the remote cannot be reached. */
	tools: () => Promise<Tool[]>
	/** The remote's instructions as it sent them; `''` while it cannot be reached. */
	instructions: () => Promise<string>
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
	/** What a call's client starts from, so a modern remote answers it in one round trip. */
	prior: PriorDiscovery
}

/**
 * One remote MCP server, set up once per process. Nothing reaches the
 * remote until its tools, its instructions or a call are asked for; the
 * first ask discovers them (`initialize` or `server/discover`, then
 * `tools/list`, with no caller's headers), and the process keeps the answer.
 * A failed discovery leaves the remote out for 30 seconds and is then tried
 * again.
 */
export function createMcpRelay<Caller>(
	options: McpRelayOptions<Caller>
): McpRelay<Caller> {
	const prefix = options.prefix ?? ''
	let discovery: Promise<Discovered | null> | undefined
	let failedAt = Number.NEGATIVE_INFINITY

	const discover = () => {
		if (discovery) return discovery
		if (Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve(null)

		discovery = discoverRemote(options.url, prefix).catch((error: unknown) => {
			discovery = undefined
			failedAt = Date.now()
			options.onError?.(error, { phase: 'discovery' })
			return null
		})
		return discovery
	}

	return {
		tools: async () => (await discover())?.tools ?? [],
		instructions: async () => (await discover())?.instructions ?? '',
		callTool: async (name, args, caller, { signal } = {}) => {
			const discovered = await discover()
			const tool = discovered?.remote.get(name)
			if (!discovered || !tool) return toolError(`Unknown tool: ${name}`)

			let headers: Record<string, string>
			try {
				headers = await options.headers(caller)
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
					{ prior: discovered.prior, ...(signal && { signal }) }
				)
				// Typed with the 2024 `toolResult` shape too; passed on as the remote sent it.
				return (await client.callTool(
					{ name: tool.name, ...(args && { arguments: args }) },
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

async function discoverRemote(url: URL, prefix: string): Promise<Discovered> {
	const client = new Client(CLIENT_INFO, {
		versionNegotiation: { mode: 'auto' }
	})
	const timeout = { timeout: DISCOVERY_TIMEOUT_MS }
	try {
		await client.connect(new StreamableHTTPClientTransport(url), timeout)

		const listed: Tool[] = []
		let cursor: string | undefined
		do {
			const page = await client.listTools(cursor ? { cursor } : {}, timeout)
			listed.push(...page.tools)
			cursor = page.nextCursor
		} while (cursor)

		const discover = client.getDiscoverResult()
		return {
			tools: listed.map((tool) => ({ ...tool, name: prefix + tool.name })),
			remote: new Map(listed.map((tool) => [prefix + tool.name, tool])),
			instructions: client.getInstructions() ?? '',
			prior: discover ? { kind: 'modern', discover } : { kind: 'legacy' }
		}
	} finally {
		await client.close().catch(() => {})
	}
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
	return `${name} failed: the service behind it could not be reached. Try again in a moment.`
}

function httpStatusOf(error: unknown) {
	if (error instanceof UnauthorizedError) return 401
	if (error instanceof SdkHttpError) return error.status
	return undefined
}

function toolError(text: string): CallToolResult {
	return { content: [{ type: 'text', text }], isError: true }
}
