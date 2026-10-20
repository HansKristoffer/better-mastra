import { rm } from 'node:fs/promises'
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })
const compiler = Bun.spawn(
	['bunx', '--no-install', 'tsc', '-p', 'tsconfig.build.json'],
	{ stdout: 'inherit', stderr: 'inherit' }
)
process.exitCode = await compiler.exited
