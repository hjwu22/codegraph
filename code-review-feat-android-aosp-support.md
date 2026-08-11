# Code Review — `feat/android-aosp-support`

| 項目 | 內容 |
|---|---|
| Repo | [hjwu22/codegraph](https://github.com/hjwu22/codegraph)(fork of `colbymchenry/codegraph`) |
| Branch | `feat/android-aosp-support` |
| Base | `main` |
| Commit | `f3e49ca` — *feat: add Android AOSP graph support* |
| 規模 | 34 檔案,+4068 / −33 行,無未提交變更 |
| 審查模式 | xhigh(10 個 inline 角度 → dedup → sweep) |
| 結果 | 15 項發現:correctness 10、efficiency 3、conventions 2 |

**驗證狀態**:`node_modules` 未安裝,因此**未執行** `npm test` 或 `tsc`。以下判斷來自程式碼閱讀;其中 4 項(#1、#2、#6、#9)另以獨立 node script 重現了實際行為,重現輸出附在各項下方。

---

## 摘要

這個 PR 的架構方向是合理的:新增的 AOSP DSL 都走「容忍式、不求值」的專用 extractor,不執行 Soong/Make/Starlark/dtc,`node kind` / `edge kind` 採 append-only 並同步更新了 Rust kernel 鏡像。主要問題集中在三類:

1. **正則式解析器的邊界條件** — 巢狀結構、註解、屬性前綴。這些在扁平的測試 fixture 上全數通過,但在真實 AOSP 檔案上會大量失效(#1、#2、#6、#8)。
2. **AOSP 專用行為外溢到非 AOSP 專案** — `isAospWorkspace` 這個 gate 只用在 resource 掃描政策上,語言偵測與 XML 語意判斷都沒有套用(#4、#11)。
3. **持久化與設定的語意落差** — ref metadata 寫了但存不進 DB(#5);關掉 resource 索引會連帶關掉 build/vendor 樹(#7);compile_commands 逐檔範圍化在無 `-I` 時退化成空陣列(#3,這項會影響**所有** C/C++ 專案,不限 AOSP)。

已確認**沒有**問題的部分(有查過,列出來避免重複勞動):

- `codegraph-kernel/src/buffers.rs` 的 `NODE_KINDS` (27) / `EDGE_KINDS` (17) 鏡像與 `src/types.ts` 一致。
- `function_ref` 在 wire 上是固定碼 `200`,不會被新增的 5 個 edge kind 撞到。
- `package.json` 的 `copy-assets` 用 glob 掃 `src/extraction/wasm/*.wasm`,新的兩個 `.wasm` 會自動打包(對應 `CLAUDE.md:30` 的規定)。
- `ReferenceKind = EdgeKind | 'function_ref'`,新增 edge kind 自動成為合法 reference kind,不需另外改。
- `new ScopeIgnore(...)` 全 repo 只有一處呼叫,且有傳 `rootDir`,沒有遺漏的建構點。
- `DEFAULT_IGNORE_DIRS` 只用來組 pattern,沒有獨立的目錄名跳過邏輯,所以 `!/build/`、`!/vendor/` 的否定式確實會生效。
- `EXTRACTION_VERSION` 25 → 26 有 bump,會強制重新索引。

---

## Correctness

### 1. Device Tree 解析跳過所有巢狀節點 — 真實 .dts 幾乎全失效

`src/extraction/aosp-extractor.ts:455`

`extractDeviceTree` 在處理完一個一般節點後執行 `nodeRe.lastIndex = end + 1`,`end` 是該節點的右大括號位置,於是**整個子樹被跳過**,任何子節點都不會被抽取。

真實的 .dts 一定是巢狀的:

```dts
/ {
  soc {
    uart0: serial@1000 { compatible = "acme,uart-v2"; };
    i2c@2000 { compatible = "acme,i2c"; };
  };
};
```

用本檔案的 `nodeRe` + `braceEnd` 獨立重現:

```
TEST1 devicetree nodes found: ["soc"]
```

`uart0` 和 `i2c@2000` 全部遺失。由於**只有巢狀節點才帶 `compatible=`**,`deviceTreeDriverSynthesizer` 與 `deviceTreeBindingSynthesizer`(兩者都以 `signature?.includes('compatible=')` 過濾)在真實 kernel tree 上會抓不到任何東西。

更明確的內部矛盾:同一函式 `:447` 的註解寫著 fragment 分支刻意不跳,好讓「nested `__overlay__` child devices remain eligible for ordinary node extraction」—— 但 ordinary node extraction 正是會跳過它們的那條路徑。

`__tests__/aosp-extraction.test.ts` 的 fixture 是扁平的頂層節點,所以測試會過。

### 2. `braceEnd` 把註解裡的單引號當成字串開頭 — 整個檔案被吞掉

`src/extraction/aosp-extractor.ts:171`(以及 `starlarkAttributeExpression` 的同款邏輯 `:339`)

`braceEnd` 追蹤引號狀態,但**不處理 `#` / `//` 註解**。註解裡的一個撇號就會開啟一個假的字串狀態,把後面整個檔案吃進去。

```python
cc_library(
    name = "a",
    # Don't use this target directly.
    srcs = ["a.c"],
)

cc_library(
    name = "b",
    srcs = ["b.c"],
)
```

獨立重現:

```
TEST2 starlark targets: [{"type":"cc_library","name":"a","bodyLen":127}]
```

`Don't` 的 `'` 開啟引號狀態 → `braceEnd` 找不到配對的 `)` → 第一個 target 的 body 延伸到 EOF → `ruleRe.lastIndex` 跳過整份檔案 → target `b` 完全消失。

AOSP 的 `Android.bp`(`//` 註解)與 BUILD 檔中英文縮寫撇號極常見,一個註解就能靜默截斷整檔抽取。

### 3. compile_commands 逐檔範圍化在無專案內 `-I` 時退化成空陣列(影響所有 C/C++ 專案)

`src/resolution/import-resolver.ts:532`

```ts
if (cached !== undefined) return filePath && cached.byFile.has(filePath) ? cached.byFile.get(filePath)! : cached.all;
```

只要 `byFile.has(filePath)` 就回傳該筆,而 `:616` 無條件為每個有 `file` 欄位的 entry 建立索引 —— 即使該 entry 的 `entryDirs` 是空的。

```json
{ "file": "src/a.cpp",
  "arguments": ["clang++", "-I/usr/include", "-isystem", "/opt/sdk/inc", "-c", "src/a.cpp"] }
```

所有 `-I` 都是專案外的絕對路徑,`:606` 的過濾條件(`!relPath.startsWith('..') && !path.isAbsolute(relPath)`)讓 `entryDirs` 保持空集合,但 `byFile.set('src/a.cpp', [])` 照樣執行。`resolveCppIncludePath` 於是對這個檔案搜尋 **0 個目錄**,而改動前它會搜尋 `all` 裡的全部目錄。

這是**既有行為的 regression**,而且不限 AOSP —— 任何帶 `compile_commands.json` 的 C/C++ 專案都會受影響。新增的測試 `__tests__/resolution.test.ts` 兩個 fixture 都有專案內 `-I`,涵蓋不到這個路徑。

修法:`byFile` 命中但值為空時 fallback 回 `all`,或一開始就不要為空的 entry 建索引。

### 4. 任何含 `<configuration>` 的 XML 都被當成 Tradefed 設定檔

`src/extraction/android-xml-extractor.ts:11`

```ts
return /<resources(?:\s|>)|<(?:compatibility-matrix|manifest)\b[^>]*\btype\s*=|<overlayable(?:\s|>)|<configuration(?:\s|>)/.test(source);
```

**每一個 Maven `pom.xml`** 都含有 plugin 區塊裡的 `<configuration>`(以及 `<build>` 裡的 `<resources>`)。於是在任何 Java 專案中:

`pom.xml` → `extractFromSource` 走 `AndroidXmlExtractor` 分支 → `extract()` 第一個條件命中 → `extractTradefed()` → 產生一個以檔名命名的 `build_target` 節點(`description` 屬性不存在,fallback 到 `path.posix.basename(filePath, '.xml')` = `pom`,qualifiedName `tradefed:pom.xml`),外加從任何 `<option name= value=>` 抓到的 `depends_on` / `configures` refs。

結果是每個 Maven 專案的圖裡都多出假的 build_target 節點與邊。這裡完全沒有諮詢 `isAospWorkspace` gate。

### 5. Ref metadata 被 cast 掉,永遠寫不進 DB

`src/extraction/aosp-extractor.ts:125`

```ts
this.unresolvedReferences.push({
  fromNodeId: from.id, referenceName: cleaned, referenceKind: kind, line, column: 0,
  ...(metadata ? { metadata } : {}),
} as UnresolvedReference);
```

- `src/types.ts:366` 的 `UnresolvedReference` **沒有 `metadata` 欄位**
- `src/db/schema.sql:88` 的 `unresolved_refs` **沒有 metadata 欄位**

`select({"//x:arm64": ["//common:arm64_base"]})` 這種 dep 會帶 `metadata.variant` 被抽出來,`__tests__/aosp-extraction.test.ts` 也有斷言 —— 但那是對**記憶體中的 `ExtractionResult`** 斷言。索引落地後,`src/aosp/build-graph.ts:150` 的

```ts
const metadata = (r as unknown as { metadata?: { variant?: string[] } }).metadata;
```

永遠拿到 `undefined`,所以正式環境下每個 `BuildTarget.variants` 都是空陣列。

`as UnresolvedReference` 這個 cast 正是壓掉編譯錯誤、讓這個落差得以存在的原因。

### 6. `attr()` 正則缺少前置邊界,會誤配後綴屬性

`src/extraction/android-xml-extractor.ts:60`

```ts
return new RegExp(`(?:android:)?${name}\\s*=\\s*["']([^"']+)["']`).exec(attrs)?.[1];
```

沒有前置的 word / namespace 邊界,任何**以目標名稱結尾**的屬性都會先命中。獨立重現:

```
TEST3  attr(' tools:layout_name="oops" android:name=".Real"', 'name')  → "oops"   (應為 ".Real")
TEST3b attr(' superclass="Bad" class="Good"', 'class')                 → "Bad"    (應為 "Good")
```

在 `extractManifest` 裡,只要 activity/service/provider 前面有任何以 `name` 結尾的屬性(`layout_name`、`taskAffinityName`、`functionalTest` 等),元件就會被錯誤命名;`extractTradefed` 的 `attr(..., 'class')` 則會被 `superclass=` 攔截。

建議加上 `(?:^|\s)(?:[\w.-]+:)?` 前綴。

### 7. 關閉 resource 索引會連帶排除 `build/` 與 `vendor/`

`src/extraction/index.ts:241`

```ts
if (!profileEnabled || !config.indexAndroidResources) {
  return DEFAULT_IGNORE_PATTERNS;
}
```

`indexAndroidResources: false` 是一個合理的設定 —— 團隊不想索引 framework resource XML。但這個 early return 同時丟掉了 `'!/build/'` 與 `'!/vendor/'` 兩個否定式,於是整個 Soong/Make/Bazel 建置系統(`build/soong`、`build/make`、`build/bazel`)與所有 vendor source **也一起從索引裡消失**。

兩個關注點本來就不相關,不該共用同一個開關。`__tests__/android-aosp-xml.test.ts:160` 只斷言了 resource 那一半,涵蓋不到。

### 8. AIDL `backend{}` 中未列出的 backend 被當成停用

`src/extraction/aosp-extractor.ts:264`

```ts
if (backendProperty && !block) continue;
```

AIDL 的語意是 java / cpp / ndk **預設啟用**,`backend { ... }` 區塊只覆寫它有提到的項目。目前的邏輯反過來:只要有 `backend` 屬性,沒被明確列出的 backend 就跳過。

```
aidl_interface {
  name: "android.hardware.foo",
  backend: { rust: { enabled: true } },
}
```

這是常見寫法。java、cpp、ndk 都沒有 block → `:264` 全部跳過 → 只產出 rust 的 generated resource 節點與 `generates` 邊,但 Soong 實際上會為這個 module 產生 java/cpp/ndk artifacts。任何沿 `generates` 邊去找 AIDL 產物的消費端都會漏掉。

附帶:per-backend 的 `\b${backend}\s*:\s*\{([\s\S]*?)\}` 是非貪婪的,遇到巢狀物件會在第一個 `}` 就截斷。

### 9. VINTF 參照行號漏算開頭標籤長度

`src/extraction/android-xml-extractor.ts:148`

```ts
for (const fq of body.matchAll(/<fqname>\s*([^<]+)\s*<\/fqname>/g))
  this.ref(service, fq[1]!.trim(), 'binds', this.lineAt(hal.index! + fq.index!));
```

`fq.index` 是相對於 `hal[2]`(body,從 `<hal ...>` 標籤之後開始)的偏移,不是相對於 `hal.index`。獨立重現:

```
TEST4 fqname reported line = 4 | actual line = 5
```

誤差隨開頭標籤長度與 hal body 內先前行數累積,所有 VINTF `binds` 參照都會指到錯誤的行。同檔案的 `<interface>` 迴圈(`:149`)有相同問題。

同 PR 內的其他 extractor 做對了 —— `aosp-extractor.ts:1019`(AIDL)與 `:1292`(HIDL)都用 `open + 1 + match.index`。

### 10. Make 的 append 判斷用 `raw.includes('+=')` 而非實際匹配到的運算子

`src/extraction/aosp-extractor.ts:416`

```ts
const assignment = /^\s*([A-Za-z0-9_.$(){}-]+)\s*(?::=|\+=|=)\s*(.*?)\s*$/.exec(...);
...
vars.set(assignment[1]!, raw.includes('+=') ? [...current, ...values] : values);
```

運算子的 alternation 是 non-capturing,所以只好用整行 `includes` 去猜。任何 `:=` / `=` 但值裡含字面 `+=` 的行(例如 `LOCAL_CFLAGS := -DVERSION_SUFFIX+=1`)會被當成 append,前一個值不會被取代而是被合併。對 `LOCAL_SRC_FILES` / `LOCAL_SHARED_LIBRARIES` 而言,這會把同檔案前一個 module 的殘留值帶進來。

把運算子改成 capturing group 即可消除猜測。

---

## Efficiency

### 11. Starlark / devicetree 的 WASM grammar 會被載入,但從來不用

`src/extraction/grammars.ts:60`(以及 `:368` 的 `VENDORED_WASM_LANGS`)

`starlark` 與 `devicetree` 同時出現在:

- `WASM_GRAMMAR_FILES` + `VENDORED_WASM_LANGS`(vendored 共約 490 KB 的 `.wasm`)
- `AOSP_CUSTOM_LANGUAGES`(`:712`)

而 `src/extraction/tree-sitter.ts:6707` 的 `AOSP_CUSTOM_LANGUAGES.has(detectedLanguage)` 分支**排在 WASM 路徑之前**,`AospArtifactExtractor` 的 switch 也確實有 `case 'starlark'` / `case 'devicetree'` 走正則實作。也就是說這兩個 parser 永遠不會被呼叫。

但 `loadGrammarsForLanguages` 的過濾條件是 `lang in WASM_GRAMMAR_FILES`,所以只要 repo 裡有 `BUILD` / `.bzl` / `.dts`,索引時就會:從磁碟讀這兩個 `.wasm` → 透過 `grammarBuffers`(`src/extraction/index.ts:1670`)廣播到**每個** parse worker → 各自 instantiate。純粹的啟動成本與 per-worker heap,換不到任何東西。

`isGrammarLoaded` 在 `:578` 那句 `&& language !== 'starlark' && language !== 'devicetree'` 例外,存在的唯一理由就是維持這個假象的一致性。

建議:要嘛把這兩個語言從 `AOSP_CUSTOM_LANGUAGES` 拿掉並真的用 tree-sitter 解析(順帶解決 #1 和 #2),要嘛把 wasm 與 grammar 註冊一起刪掉。

### 12. `lineAt` 每次呼叫都切片並 split 整份原始碼

`src/extraction/android-xml-extractor.ts:59`(同款問題在 `src/extraction/aosp-metadata-extractor.ts:31`)

```ts
private lineAt(offset: number): number { return this.source.slice(0, offset).split('\n').length; }
```

在 per-match 迴圈裡呼叫 → O(n²)。而同 PR 的 `AospArtifactExtractor` 已經有正確做法:`:143` 用預先算好的 `lineStarts` 陣列做二分搜尋。

AOSP framework resource 檔案很大(`frameworks/base/core/res/res/values/symbols.xml` 超過 1 MB,數萬個 `<item name=...>`)。`extractResources` 每個 match 呼叫一次 `lineAt`,`extractSymbolicReferences` 每個 `@type/name` 出現又呼叫一次,每次都複製並切分檔案的一段前綴。

而且 AOSP profile 正是刻意把這些檔案從 ignore 清單裡放出來的(`src/extraction/index.ts:241`),所以這條路徑就是這個功能啟用的主路徑。直接複用 `aosp-extractor.ts:143` 的實作即可。

### 13. `aidlBinderSynthesizer` 是 O(interfaces × types) 而且迴圈內有檔案 I/O

`src/resolution/aosp-synthesizer.ts:240`

```ts
for (const iface of interfaces) {
  ...
  const boundTypes = types.filter((n) => {
    if (generatedNames.has(n.name)) return true;
    const source = sourceLine(context, n);          // ← 讀檔 + split
    return source.includes(iface.name) && /(?:implements|extends|:)/.test(source);
  });
```

AOSP 有數千個 `.aidl` interface,以及數十萬個 java/kotlin/c/cpp/rust 的 class + struct + interface 節點。每個 interface 都重新過濾整個 `types` 陣列,且對每個不在 `generatedNames` 裡的 type 呼叫 `sourceLine()`(`getFileLines` 不可用時會讀整個檔案並 split)。乘積是數百萬次 predicate 評估外加 per-node 檔案查找。

`:251` 的 `methods.filter(...)` 又對每個 AIDL method 再掃一次全表。

建議照同檔 `jniSynthesizer` 在 `:133` 建 `byName` 的做法,把 name-keyed index 提到 interface 迴圈外面。

---

## Conventions(CLAUDE.md)

### 14. `CLAUDE.md` 的 NodeKind / EdgeKind 清單未同步

`src/types.ts:48`

`CLAUDE.md:67-70` 明文寫著:

> Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.
>
> - **NodeKind**: `file`, `module`, ... , `route`, `component`, `union`.
> - **EdgeKind**: `contains`, `calls`, ... , `overrides`, `decorates`.

本 PR 在 `src/types.ts:48` 新增 `build_target`、`service`、`resource`、`device`,在 `:77` 新增 `depends_on`、`generates`、`binds`、`configures`、`overlays`,但 `CLAUDE.md` 完全沒動。

同樣地 `src/bin/codegraph.ts:593` 新增了 `aosp` 子指令,而 `CLAUDE.md:62` 的子指令清單仍止於 `serve --mcp`。

`CLAUDE.md` 每個 session 都會被載入當作權威的 kind 清單,照著它寫 extractor 的 agent 不會知道新 kind 的存在。

### 15. 新增的 synthesizer 未走必要的驗證流程

`src/resolution/aosp-synthesizer.ts:370`

`CLAUDE.md:134` 的段落標題是:

> Validation methodology (**REQUIRED** for every new language/framework)

`CLAUDE.md:145` 要求:

> Record the numbers in `docs/design/dynamic-dispatch-coverage-playbook.md` (the coverage matrix).

本 PR 在 `AOSP_GRAPH_SYNTHESIZERS` 註冊了 7 個新的 heuristic edge producer(jni、aidl-binder、devicetree-driver、devicetree-binding、init-service、hal-vintf、selinux-binding),並在 `src/resolution/index.ts:1950` 無條件掛進 `ReferenceResolver`(對**每一個**被索引的專案都會跑),另外新增 11 個語言。

但 `docs/design/dynamic-dispatch-coverage-playbook.md` 與 `docs/design/callback-edge-synthesis.md` 都沒有被修改 —— branch 只新增了一個 `docs/achievements/` 目錄(`main` 上不存在這個目錄)。

沒有記錄 probe / A-B 數字,就無從對照 `CLAUDE.md:132` 的原則:

> **Principle: partial coverage is WORSE than none.**

---

## 建議的處理順序

| 優先 | 項目 | 理由 |
|---|---|---|
| P0 | #3 | 唯一一項會 regress 既有非 AOSP 功能(所有帶 compile_commands 的 C/C++ 專案) |
| P0 | #1、#2 | 功能宣稱的核心能力在真實輸入上大量失效,但測試全綠 |
| P1 | #5、#7 | 「設定/資料寫了但沒生效」類,靜默失敗最難查 |
| P1 | #4 | 汙染所有 Java/Maven 專案的圖 |
| P2 | #6、#8、#9、#10 | 局部正確性,影響範圍明確 |
| P2 | #11 | 與 #1/#2 的修法綁在一起決策(改用 tree-sitter,或刪掉 wasm) |
| P3 | #12、#13 | AOSP 規模下才會痛,但 AOSP 正是本 PR 的目標場景 |
| P3 | #14、#15 | 文件與流程,合併前補齊 |
