import type {
	HandlerResultTypeMap,
	RequestTypeMap,
	Server,
	ServerContext,
	Tool
} from '@modelcontextprotocol/server'
import type { McpRelay } from './relay.js'

/** What registers a server's tools: the low-level `Server`, or `McpServer.server`. */
export type ToolsServer = Pick<Server, 'setRequestHandler'>

type Handler<Method extends 'tools/list' | 'tools/call'> = (
	request: RequestTypeMap[Method],
	ctx: ServerContext
) => HandlerResultTypeMap[Method] | Promise<HandlerResultTypeMap[Method]>

/**
 * `server` with the relays' tools added to its own, for one request. Pass
 * the result to whatever registers the host's tools (orpc-fn's
 * `registerMcpTools`, or your own `setRequestHandler` calls): it keeps the
 * host's `tools/list` and `tools/call` handlers and answers both with the
 * host's tools and the relayed ones. A relayed call goes to its remote as
 * `caller`; any other call reaches the host's handler without touching a
 * remote. The server must declare the `tools` capability.
 *
 * A relayed tool named like a host tool, or like another relay's, fails the
 * `tools/list` request: give a relay a `prefix`.
 */
export function withRelayedTools<Caller>(
	server: ToolsServer,
	relays: readonly McpRelay<Caller>[],
	options: { caller: Caller }
): ToolsServer {
	let hostList: Handler<'tools/list'> | undefined
	let hostCall: Handler<'tools/call'> | undefined

	const hostTools = async (
		request: RequestTypeMap['tools/list'],
		ctx: ServerContext
	) => (hostList ? await hostList(request, ctx) : { tools: [] })

	/** The relays' tools by name, each with the relay that owns it. */
	const relayedTools = async (taken: Iterable<string>) => {
		const names = new Set(taken)
		const owners = new Map<string, { tool: Tool; relay: McpRelay<Caller> }>()
		const listed = await Promise.all(relays.map((relay) => relay.tools()))

		listed.forEach((tools, index) => {
			const relay = relays[index]!
			for (const tool of tools) {
				if (names.has(tool.name)) {
					throw new Error(
						`better-mastra/mcp-relay: the relayed tool ${tool.name} has the name of another tool on this server. Give its relay a prefix.`
					)
				}
				names.add(tool.name)
				owners.set(tool.name, { tool, relay })
			}
		})
		return owners
	}

	server.setRequestHandler('tools/list', async (request, ctx) => {
		const host = await hostTools(request, ctx)
		// Relayed tools come with the first page; a later one is the host's.
		if (request.params?.cursor) return host

		const relayed = await relayedTools(host.tools.map((tool) => tool.name))
		const tools = [...relayed.values()].map(({ tool }) => tool)
		return { ...host, tools: [...host.tools, ...tools] }
	})

	server.setRequestHandler('tools/call', async (request, ctx) => {
		const { name } = request.params
		const host = await hostTools({ method: 'tools/list', params: {} }, ctx)
		const isHostTool = host.tools.some((tool) => tool.name === name)

		const relayed = isHostTool ? undefined : (await relayedTools([])).get(name)
		if (relayed) {
			return relayed.relay.callTool(
				name,
				request.params.arguments,
				options.caller,
				{
					signal: ctx.mcpReq.signal
				}
			)
		}
		if (hostCall) return hostCall(request, ctx)
		return {
			content: [{ type: 'text', text: `Unknown tool: ${name}` }],
			isError: true
		}
	})

	const setRequestHandler = (method: string, ...rest: unknown[]) => {
		// The two-argument form; the three-argument one is for custom methods.
		if (rest.length === 1 && method === 'tools/list') {
			hostList = rest[0] as Handler<'tools/list'>
		} else if (rest.length === 1 && method === 'tools/call') {
			hostCall = rest[0] as Handler<'tools/call'>
		} else {
			Reflect.apply(server.setRequestHandler, server, [method, ...rest])
		}
	}
	return {
		setRequestHandler: setRequestHandler as ToolsServer['setRequestHandler']
	}
}
