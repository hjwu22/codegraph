# AOSP grammar provenance and health checks

CodeGraph uses tolerant semantic extractors for AOSP build/configuration DSLs.
Where a maintained WebAssembly Tree-sitter grammar is available, the grammar is
also vendored and health-checked so syntax validation and future AST migration
have a pinned, reproducible base.

## Starlark

- Source package: `tree-sitter-starlark@1.3.0`
- Upstream: `tree-sitter-grammars/tree-sitter-starlark`
- License: MIT
- Artifact: `src/extraction/wasm/tree-sitter-starlark.wasm`
- Artifact SHA-256:
  `fbc8daea386fbd963b198e7942d9a020b8c74d4d875d1c075af540f2b6b3278d`
- npm tarball integrity:
  `sha512-23BgGxRSbWHq6xMR3zSsLsCfTM6iy3Cweg60QHMLzlR16z1zwilbwPItrKKCuYgeGH7SAL5eG2BUBr3yEYM+hw==`
- Runtime ABI: 14
- Health check: 50 clean parses, zero error trees, using a second grammar in
  the same `web-tree-sitter` runtime.

## Device Tree

- Source package: `tree-sitter-devicetree@0.15.0`
- Upstream: `joelspadin/tree-sitter-devicetree`
- License: MIT
- Artifact: `src/extraction/wasm/tree-sitter-devicetree.wasm`
- Artifact SHA-256:
  `22bc4094fb07314e1fdcf8e2d2cc24814ff874b47f6fdd3f7702b56de5e65ad8`
- npm tarball integrity:
  `sha512-O+Wpo+3WZCvDgspXYpqRfU0euy5yMB6rV+nRF0Ytm+jbUldIf7rFtBqv7XweB/gkSLl/pbqLD1IVis+MTuOQKA==`
- Runtime ABI: 15
- Health check: 50 clean parses, zero error trees, using a second grammar in
  the same `web-tree-sitter` runtime.

## Reproduction

```sh
node scripts/add-lang/check-grammar.mjs starlark __tests__/fixtures/aosp/BUILD.bazel 50
node scripts/add-lang/check-grammar.mjs devicetree __tests__/fixtures/aosp/board.dts 50
node scripts/add-lang/dump-ast.mjs starlark __tests__/fixtures/aosp/BUILD.bazel --depth=4
node scripts/add-lang/dump-ast.mjs devicetree __tests__/fixtures/aosp/board.dts --depth=4
```

The other AOSP DSLs in the initial implementation do not currently have a
healthy, maintained, prebuilt WASM artifact in the package set used by the
project. They stay on dedicated non-evaluating extractors; they are not falsely
reported as Tree-sitter-backed grammars.
