# Agent notes

- Bun, TypeScript strict, Biome. Run `bun run lint:write` and `bun test` before committing.
- Tooling (tsconfig, biome, build script, CI and release-please) mirrors `HansKristoffer/better-graphile-worker`; copy from there rather than inventing new setups.
- Each subpath export lives in its own `src/<subpath>/` folder with an `index.ts`, and is listed in `package.json` `exports`.
- Keep the library a thin layer: prefer native features of the peer libraries over wrappers.
- Never publish to npm or merge release PRs; the maintainer does that.
