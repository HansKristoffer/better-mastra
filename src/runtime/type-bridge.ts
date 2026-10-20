import type { MastraCompositeStore } from '@mastra/core/storage'

/**
 * A store from @mastra/pg or @mastra/libsql typed as @mastra/core's. Bun and
 * pnpm can resolve those packages to a different @mastra/core copy than the
 * app's, and the private fields of the two copies make the types disagree
 * although the objects are the same.
 */
export const asMastraStorage = (storage: unknown): MastraCompositeStore =>
	storage as MastraCompositeStore
