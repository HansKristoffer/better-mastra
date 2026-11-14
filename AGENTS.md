# Agent notes

- Bun, TypeScript strict. `bun check` typechecks, `bun fmt` formats (options in `bunfig.toml` `[fmt]`) and Biome lints. Run `bun run lint:write` and `bun test` before committing.
- Tooling (tsconfig, biome, build script, CI and release-please) mirrors `HansKristoffer/better-graphile-worker`; copy from there rather than inventing new setups.
- Each subpath export lives in its own `src/<subpath>/` folder with an `index.ts`, and is listed in `package.json` `exports`.
- Keep the library a thin layer: prefer native features of the peer libraries over wrappers.
- A change that removes or renames an export, adds a value to a union apps switch over, or needs wiring in the app gets a section in `UPGRADING.md` in the same PR, under the version release-please will give it: each removed export with its replacement, the wiring as code, and what to check afterwards. It ships in the tarball with `CHANGELOG.md`, where upgrading agents read it.
- Never publish to npm or merge release PRs; the maintainer does that.
