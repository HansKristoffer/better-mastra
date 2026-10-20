type PromiseCacheEntry<Value> = {
	freshUntil: number
	staleUntil: number
	value: Promise<Value>
	/** The background rebuild running for a stale entry, if any. */
	refresh: Promise<Value> | null
}

type BoundedPromiseCacheOptions<Key> = {
	/** How long a value is served without triggering any reload. */
	freshMs: number
	/**
	 * Maximum age (from load) a value may be served at all. Between `freshMs`
	 * and `staleMs` the stale value is returned while a rebuild runs in the
	 * background; past `staleMs` the caller pays the reload inline. Omitted (or
	 * `<= freshMs`) makes this a plain TTL cache.
	 */
	staleMs?: number
	maxEntries: number
	now?: () => number
	/**
	 * Fired when a caller has to wait for a reload because the entry is past
	 * `staleMs` - the case a voice first-audio path must never hit.
	 */
	onBlockingReload?: (key: Key) => void
}

/**
 * Small in-process promise cache: bounded, shares work already in flight,
 * evicts a rejected first load so the next caller retries, and - when
 * `staleMs > 0` - serves the stale value while it revalidates in the
 * background. A failed background rebuild keeps serving the stale value
 * until the stale window closes.
 */
export class BoundedPromiseCache<Key, Value> {
	private readonly entries = new Map<Key, PromiseCacheEntry<Value>>()
	private now: () => number

	constructor(private readonly options: BoundedPromiseCacheOptions<Key>) {
		this.now = options.now ?? Date.now
	}

	/** Test seam: pin the clock. `null` restores `Date.now`. */
	setNowForTests(now: (() => number) | null) {
		this.now = now ?? this.options.now ?? Date.now
	}

	/** Reports a fresh OR stale entry - anything `getOrLoad` would return without a blocking reload. */
	has(key: Key) {
		const cached = this.entries.get(key)
		return Boolean(cached && cached.staleUntil > this.now())
	}

	/** Drop every entry. Test seam for module-level caches. */
	clear() {
		this.entries.clear()
	}

	delete(key: Key) {
		this.entries.delete(key)
	}

	deleteWhere(predicate: (key: Key) => boolean) {
		for (const key of this.entries.keys()) {
			if (predicate(key)) this.entries.delete(key)
		}
	}

	getOrLoad(
		key: Key,
		load: () => Promise<Value>,
		/**
		 * `serveStale: false` takes the reload inline once the fresh window has
		 * passed. Serve-stale exists for voice first-audio; on a written channel
		 * it only meant an owner's settings change took up to `staleMs` to show
		 * up, because invalidation never leaves the process that served it.
		 */
		options?: { serveStale?: boolean }
	): Promise<Value> {
		const now = this.now()
		const cached = this.entries.get(key)
		if (cached) {
			if (cached.freshUntil > now) return cached.value
			if (cached.staleUntil > now) {
				if (options?.serveStale !== false) {
					this.scheduleRefresh(key, cached, load)
					return cached.value
				}
			} else {
				// Only a caller that WANTED the stale value is surprised by this.
				this.options.onBlockingReload?.(key)
			}
			this.entries.delete(key)
		}

		this.evictIfNeeded(now)

		const value = load()
		const entry = this.entryFor(now, value)
		this.entries.set(key, entry)
		value.catch(() => {
			if (this.entries.get(key) === entry) this.entries.delete(key)
		})
		return value
	}

	private scheduleRefresh(
		key: Key,
		cached: PromiseCacheEntry<Value>,
		load: () => Promise<Value>
	) {
		if (cached.refresh) return
		const refresh = load()
		cached.refresh = refresh
		refresh
			.then((value) => {
				if (this.entries.get(key) !== cached) return
				this.entries.set(key, this.entryFor(this.now(), Promise.resolve(value)))
			})
			.catch(() => {
				// Keep serving the stale value; the next read past `freshMs` retries.
				if (this.entries.get(key) === cached) cached.refresh = null
			})
	}

	private entryFor(
		now: number,
		value: Promise<Value>
	): PromiseCacheEntry<Value> {
		const { freshMs, staleMs = 0 } = this.options
		return {
			freshUntil: now + freshMs,
			staleUntil: now + Math.max(freshMs, staleMs),
			value,
			refresh: null
		}
	}

	private evictIfNeeded(now: number) {
		if (this.entries.size < this.options.maxEntries) return
		for (const [key, entry] of this.entries) {
			if (entry.staleUntil <= now) this.entries.delete(key)
		}
		if (this.entries.size < this.options.maxEntries) return
		const oldest = this.entries.keys().next()
		if (!oldest.done) this.entries.delete(oldest.value)
	}
}
