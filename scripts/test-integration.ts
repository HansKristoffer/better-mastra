import { randomBytes } from 'node:crypto'

const POSTGRES_IMAGE = process.env.POSTGRES_IMAGE ?? 'postgres:16-alpine'
const REDIS_IMAGE = process.env.REDIS_IMAGE ?? 'redis:7-alpine'
const READY_TIMEOUT_MS = 30_000
const READY_POLL_MS = 200

const containers: string[] = []
let cleanedUp = false
let testProc: ReturnType<typeof Bun.spawn> | undefined

function cleanup() {
	if (cleanedUp || containers.length === 0) return
	cleanedUp = true
	Bun.spawnSync(['docker', 'rm', '-fv', ...containers], {
		stdout: 'ignore',
		stderr: 'ignore'
	})
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
	process.on(signal, () => {
		testProc?.kill(signal)
		cleanup()
		process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129)
	})
}

function runDocker(args: string[]): string {
	const result = Bun.spawnSync(['docker', ...args], {
		stdout: 'pipe',
		stderr: 'pipe'
	})
	if (result.exitCode !== 0) {
		const stderr = result.stderr.toString().trim()
		throw new Error(`docker ${args.join(' ')} failed: ${stderr}`)
	}
	return result.stdout.toString().trim()
}

function publishedPort(container: string, containerPort: number): number {
	const out = runDocker(['port', container, `${containerPort}/tcp`])
	const firstLine = out.split(/\r?\n/)[0]?.trim() ?? ''
	const match = firstLine.match(/:(\d+)$/)
	if (!match?.[1]) {
		throw new Error(
			`Could not parse published port for ${container}:${containerPort} from "${out}"`
		)
	}
	return Number(match[1])
}

async function waitForReady(
	container: string,
	checkArgs: string[],
	label: string
) {
	const deadline = Date.now() + READY_TIMEOUT_MS
	while (Date.now() < deadline) {
		const proc = Bun.spawn(['docker', 'exec', container, ...checkArgs], {
			stdout: 'ignore',
			stderr: 'ignore'
		})
		if ((await proc.exited) === 0) return
		await Bun.sleep(READY_POLL_MS)
	}
	const logs = Bun.spawnSync(['docker', 'logs', '--tail', '50', container], {
		stdout: 'pipe',
		stderr: 'pipe'
	})
	const output = [logs.stdout.toString(), logs.stderr.toString()]
		.filter(Boolean)
		.join('\n')
		.trim()
	throw new Error(
		`${label} (${container}) did not become ready within ${READY_TIMEOUT_MS}ms${output ? `\n${output}` : ''}`
	)
}

async function startPostgres(runId: string): Promise<string> {
	const name = `better-mastra-pg-${runId}`
	containers.push(name)
	runDocker([
		'run',
		'-d',
		'--rm',
		'--name',
		name,
		'--label',
		'better-mastra-test=1',
		'--tmpfs',
		'/var/lib/postgresql/data',
		'-e',
		'POSTGRES_USER=postgres',
		'-e',
		'POSTGRES_PASSWORD=postgres',
		'-e',
		'POSTGRES_DB=better_mastra_test',
		'-p',
		'127.0.0.1:0:5432',
		POSTGRES_IMAGE,
		'-c',
		'fsync=off',
		'-c',
		'synchronous_commit=off',
		'-c',
		'full_page_writes=off'
	])
	// Target 127.0.0.1 so pg_isready only succeeds after initdb switches from the temp Unix socket to TCP.
	await waitForReady(
		name,
		[
			'pg_isready',
			'-h',
			'127.0.0.1',
			'-p',
			'5432',
			'-U',
			'postgres',
			'-d',
			'better_mastra_test'
		],
		'Postgres'
	)
	const port = publishedPort(name, 5432)
	return `postgres://postgres:postgres@127.0.0.1:${port}/better_mastra_test`
}

async function startRedis(runId: string): Promise<string> {
	const name = `better-mastra-redis-${runId}`
	containers.push(name)
	runDocker([
		'run',
		'-d',
		'--rm',
		'--name',
		name,
		'--label',
		'better-mastra-test=1',
		'--tmpfs',
		'/data',
		'-p',
		'127.0.0.1:0:6379',
		REDIS_IMAGE,
		'redis-server',
		'--save',
		'',
		'--appendonly',
		'no'
	])
	await waitForReady(
		name,
		['redis-cli', '-h', '127.0.0.1', '-p', '6379', 'ping'],
		'Redis'
	)
	const port = publishedPort(name, 6379)
	return `redis://127.0.0.1:${port}`
}

async function main() {
	const needsPostgres = !process.env.DATABASE_URL
	const needsRedis = !process.env.REDIS_URL

	if (needsPostgres || needsRedis) {
		const check = Bun.spawnSync(['docker', 'info'], {
			stdout: 'ignore',
			stderr: 'pipe'
		})
		if (check.exitCode !== 0) {
			console.error(
				'test:integration requires a running Docker daemon (or preset DATABASE_URL and REDIS_URL).'
			)
			process.exitCode = 1
			return
		}
	}

	const runId = randomBytes(4).toString('hex')
	const [databaseUrl, redisUrl] = await Promise.all([
		needsPostgres
			? startPostgres(runId)
			: Promise.resolve(process.env.DATABASE_URL!),
		needsRedis ? startRedis(runId) : Promise.resolve(process.env.REDIS_URL!)
	])

	testProc = Bun.spawn(['bun', 'test', ...process.argv.slice(2)], {
		env: {
			...process.env,
			DATABASE_URL: databaseUrl,
			REDIS_URL: redisUrl
		},
		stdin: 'inherit',
		stdout: 'inherit',
		stderr: 'inherit'
	})
	process.exitCode = await testProc.exited
}

try {
	await main()
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
} finally {
	cleanup()
}
