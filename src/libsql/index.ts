import { LibSQLStore } from '@mastra/libsql'
import type { MastraStorage } from '../runtime/storage.js'
import { asMastraStorage } from '../runtime/type-bridge.js'

export type { MastraStorage } from '../runtime/storage.js'

/** Mastra storage on libSQL (a local file or Turso). Needs `@mastra/libsql`. */
export function libsqlStorage(
	url: string,
	options: { id?: string } = {}
): MastraStorage {
	const store = new LibSQLStore({ id: options.id ?? 'mastra', url })
	return {
		store: asMastraStorage(store),
		init: () => store.init(),
		ping: () => store.init(),
		close: () => store.close()
	}
}
