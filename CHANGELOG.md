# Changelog

## [0.5.0](https://github.com/HansKristoffer/better-mastra/compare/v0.4.0...v0.5.0) (2026-10-26)


### Features

* **resumable:** coordinate and stop turns across replicas ([#28](https://github.com/HansKristoffer/better-mastra/issues/28)) ([ed84a97](https://github.com/HansKristoffer/better-mastra/commit/ed84a97bbc5a1e27f6885775b90fa6982d74dca2))
* **turn:** mark the answer complete before its reply suggestions ([#27](https://github.com/HansKristoffer/better-mastra/issues/27)) ([c217b30](https://github.com/HansKristoffer/better-mastra/commit/c217b3050fd3e31297c21ccb188657d530573742))

## [0.4.0](https://github.com/HansKristoffer/better-mastra/compare/v0.3.0...v0.4.0) (2026-10-21)


### Features

* per-user request limits, abandoned-run sweep hooks and an app-typed tool manifest ([#19](https://github.com/HansKristoffer/better-mastra/issues/19)) ([3190e09](https://github.com/HansKristoffer/better-mastra/commit/3190e0904b78d9303fd3b3b8b78368b80f65d276))


### Bug Fixes

* **cli:** use hanzio/cli's defaultCommand for the evals run command ([#22](https://github.com/HansKristoffer/better-mastra/issues/22)) ([a4b4f14](https://github.com/HansKristoffer/better-mastra/commit/a4b4f14319402bff1c19764cfa27d0883bd49624))

## [0.3.0](https://github.com/HansKristoffer/better-mastra/compare/v0.2.0...v0.3.0) (2026-10-21)


### Features

* hellu's turn, route, client, dictation and evals follow-ups ([#20](https://github.com/HansKristoffer/better-mastra/issues/20)) ([cd1c8ac](https://github.com/HansKristoffer/better-mastra/commit/cd1c8ac00e040112cb756971414ff88ccc24a0ee))

## [0.2.0](https://github.com/HansKristoffer/better-mastra/compare/v0.1.1...v0.2.0) (2026-10-21)


### Features

* **client:** actions see their step, typed resume data ([#15](https://github.com/HansKristoffer/better-mastra/issues/15)) ([e4a694d](https://github.com/HansKristoffer/better-mastra/commit/e4a694da353136b642e4adccadff4e56e5e9197a))
* **hono:** map the chat route's own refusals to app codes ([#17](https://github.com/HansKristoffer/better-mastra/issues/17)) ([25b9fa7](https://github.com/HansKristoffer/better-mastra/commit/25b9fa76ac8eb1e0a13b5e9a07d9dd49a6a3bbce))
* isResumePoint option for joining resumed answers ([#14](https://github.com/HansKristoffer/better-mastra/issues/14)) ([791bcb1](https://github.com/HansKristoffer/better-mastra/commit/791bcb1c8e9a413053544da4531fc4536669961d))
* **react:** safeLinks 'web' for StreamingMarkdown ([#16](https://github.com/HansKristoffer/better-mastra/issues/16)) ([f689207](https://github.com/HansKristoffer/better-mastra/commit/f689207f0b7126f4f65fadbb01752ad1981a9cfc))
* **resumable:** Upstash adapter and app-owned locator ([#12](https://github.com/HansKristoffer/better-mastra/issues/12)) ([e020f3a](https://github.com/HansKristoffer/better-mastra/commit/e020f3a518435749c7760c793639ee7ed8afcd19))
* **runtime:** synchronous storage presets and OpenRouter builder ([#13](https://github.com/HansKristoffer/better-mastra/issues/13)) ([563910d](https://github.com/HansKristoffer/better-mastra/commit/563910dd86f73b9aa34f381762cb9f7f4ada5028))

## [0.1.1](https://github.com/HansKristoffer/better-mastra/compare/v0.1.0...v0.1.1) (2026-10-21)


### Miscellaneous Chores

* release 0.1.1 ([dae890a](https://github.com/HansKristoffer/better-mastra/commit/dae890a54ead4e7d367739ae7e6142a8d91a6d0a))

## 0.1.0 (2026-10-20)


### Features

* chat turn, Hono chat route and agent tools ([#3](https://github.com/HansKristoffer/better-mastra/issues/3)) ([de9124f](https://github.com/HansKristoffer/better-mastra/commit/de9124f7f2f2704a4f13f5c9d9399a55aa6c5650))
* **client:** chat session, React and Vue bindings ([#6](https://github.com/HansKristoffer/better-mastra/issues/6)) ([e4f302e](https://github.com/HansKristoffer/better-mastra/commit/e4f302edbcd5c653819f860cfa1c6c8fffd9d498))
* **dictation:** Soniox realtime dictation for React, Vue and the server ([#2](https://github.com/HansKristoffer/better-mastra/issues/2)) ([2644176](https://github.com/HansKristoffer/better-mastra/commit/2644176d97ddfa864618a6aeb4cdf8223388d7a2))
* **evals:** add evals subpath and better-mastra-evals CLI ([3ba8098](https://github.com/HansKristoffer/better-mastra/commit/3ba8098e822cf4b8ca7f7f7cd20267571e07cee8))
* **evals:** add evals subpath and better-mastra-evals CLI ([9cebfa9](https://github.com/HansKristoffer/better-mastra/commit/9cebfa99e46691a55d6dd6e02ff091273b2e1c98))
* model registry, Mastra presets, usage metering and embeddings ([#4](https://github.com/HansKristoffer/better-mastra/issues/4)) ([fff9e31](https://github.com/HansKristoffer/better-mastra/commit/fff9e31b1d0c43ffd5189825b6a8ed0b0bbe3814))
* **resumable:** memory-first resumable chat streams ([#1](https://github.com/HansKristoffer/better-mastra/issues/1)) ([690e54d](https://github.com/HansKristoffer/better-mastra/commit/690e54db0125a8102d3224cbac92e02d40e14e92))


### Miscellaneous Chores

* start releases at 0.1.0 ([#8](https://github.com/HansKristoffer/better-mastra/issues/8)) ([c48ef98](https://github.com/HansKristoffer/better-mastra/commit/c48ef985173ca339e6f198714fad4ea2ad1950cb))
