# AOSP review remediation ledger

This ledger responds to commit `4bed4c7` on
`docs/code-review-android-aosp-support`, which reviewed feature commit
`f3e49ca`. Each row records the engineering disposition rather than silently
merging the review document into production history.

| # | Finding | Disposition and proof |
|---:|---|---|
| 1 | Nested Device Tree nodes were skipped | Fixed. The scanner continues inside parent ranges while a top-level-property mask prevents parents from inheriting child `compatible`/phandle evidence. A nested `soc → uart/i2c` regression proves all children and parent isolation. |
| 2 | Comment apostrophes broke balanced scans | Fixed. Balanced scans understand `#`, `//`, and block comments as appropriate; Blueprint/Starlark semantic scans mask comments without changing offsets. Tests include `Don't` and comment-only fake dependencies followed by a second target. |
| 3 | Empty per-TU compile include list regressed C/C++ | Fixed. An empty scoped result falls back to the compilation database's project-local global set; non-empty translation-unit sets remain isolated. A two-entry regression covers system-only flags on one TU. |
| 4 | Generic Maven XML was classified as Tradefed | Fixed. Android XML routing now uses Android path/name markers or a VINTF `type` root, not generic `<resources>`/`<configuration>` content. A Maven POM negative test emits only its file node. |
| 5 | Unresolved-reference metadata was not persisted | Fixed end-to-end: typed metadata, schema column, schema v10 migration, single/batch inserts, every read path, static provider, and a DB batch round-trip test. Extraction version 27 forces re-indexing because a migration cannot reconstruct prior variant evidence. |
| 6 | XML attributes matched suffix names | Fixed with an exact whitespace/namespace boundary. Manifest `tools:layout_name` and Tradefed `superclass` negative controls prove the real `name`/`class` wins. |
| 7 | Disabling resources also excluded root build/vendor | Fixed. AOSP profile restoration of root `build/`/`vendor/` is independent of `indexAndroidResources`; the false-setting test covers all three paths. |
| 8 | Unlisted AIDL backends were treated as disabled | Fixed. Java/C++/NDK retain their enabled defaults; Rust remains opt-in; nested backend objects use a balanced property scanner. Regression covers a Rust-only override producing all four expected outputs. |
| 9 | VINTF body-relative line offsets were wrong | Fixed by adding the `<hal>` body start offset. Tests assert exact fqname and interface lines. |
| 10 | Make append detection searched the raw value | Fixed by capturing the actual assignment operator. A replacement whose literal value contains `+=` no longer retains stale sources. |
| 11 | Health-check WASMs were instantiated but unused | Fixed for runtime cost. Starlark/Device Tree remain pinned provenance artifacts, while production grammar expansion filters every dedicated AOSP custom extractor before byte read, worker broadcast, or instantiation. A regression asserts zero worker bytes and custom-extractor readiness. |
| 12 | XML/YAML line lookup was quadratic | Fixed. Both AOSP metadata extractors precompute line starts and use binary lookup; exact line tests cover the observable contract. |
| 13 | Binder synthesis rescanned every type/method | Fixed. It builds name, declared-binding, owner, and method indexes once; source declarations are read once per candidate type. The scaling regression counts three reads for three types across two interfaces. |
| 14 | `CLAUDE.md` contracts were stale | Fixed. CLI, module layout, node/edge kinds, and AOSP synthesis channels are synchronized. |
| 15 | Required dynamic-dispatch validation was undocumented | Deterministic coverage and real-repository extraction numbers are now in the canonical coverage matrix, with positive, negative, persistence, and scaling tests. The paid Sonnet/high S/M/L agent A/B is explicitly **pending authorization** and is not represented as complete. |

## Validation gate

- TypeScript build: passed.
- Focused AOSP/foundation/resolution regression: 281/281 passed.
- Starlark grammar health: ABI 14, 50/50 clean parses.
- Device Tree grammar health: ABI 15, 50/50 clean parses.
- Restricted full suite: 2,980 passed, 11 failed, 182 skipped. The failures were
  isolated to five socket/watcher or full-suite-timeout files; the same five
  files passed 78/78 with local socket/watch access.
- `codegraph aosp enrich --help`: passed with module-info, Bazel query, and
  kernel-config inputs. The four public AOSP graph/provider exports load as
  functions from the built package.
- `git diff --check`: passed.

Paid agent A/B remains a separate explicit-authorization gate and was not run.
