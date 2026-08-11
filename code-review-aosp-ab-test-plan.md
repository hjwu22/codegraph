# Agent A/B 驗證 — 針對 `feat/android-aosp-support` 的意見與可執行計畫

本文是 [code-review-feat-android-aosp-support.md](./code-review-feat-android-aosp-support.md) 第 15 項發現的延伸。該項指出這個 PR 一次加了 11 種語言與 7 個 synthesizer,卻沒有依 `CLAUDE.md:134-145` 的 **REQUIRED** 流程留下任何 probe / A-B 數字。這裡記錄兩件事:

1. 對這套 A/B 方法論本身的意見 —— 它量什麼、不量什麼、用在這個 PR 上會遇到什麼
2. 一份綁定本機實際環境的執行計畫,以及目前擋住的地方

---

## 第一部分:對 A/B 方法論的意見

### 它量的不是「對不對」,是「agent 會不會停止讀檔」

`scripts/agent-eval/run-all.sh` 對同一個 repo、同一個問題跑兩個 arm,唯一變數是有沒有掛 codegraph MCP。記錄的是 duration / 總 tool calls / Read / Grep,加上三個 feedback 指標(residual context occupancy、explore sufficiency、allocation efficiency)。

`CLAUDE.md:94` 把最佳化目標寫得很清楚:**wall-clock 時間 + tool-call 次數,不是 token 成本**。同一段也澄清了成本確實會降(7 個 repo 的 A/B 平均省 35% 成本 / 57% token / 46% 時間 / 71% tool calls),但機制是「**更少的回合數 × 更小的累積 context**」,不是 cache 命中率 —— without-arm 的巨量 token 大多是便宜的 cache read,所以 token 數的降幅(57%)看起來會比成本降幅(35%)漂亮。

**這對「省 token」這個目標的意義**:如果目的是省 token,A/B 是對的工具,但要看的是**per-turn assistant usage 的加總**,不是 `result.usage`(在目前的 Claude Code 裡只有最後一回合)。`CLAUDE.md:141` 特別點出這個陷阱。

### 三個容易誤判的地方

**一、單次 run 完全不可信。** `CLAUDE.md:140` 要求每個 arm 至少 2 次,理由是 run-to-run 變異很大。回報時要給區間,不要給單一數字。excalidraw 那個案例的 tool call 數在調整前是 3–10,調整後才收斂到 3–4 —— 如果只跑一次,3 和 10 都可能被抽到。

**二、汙染會靜默地讓數據作廢。** `no-cli-shim.sh` 用兩層(消毒 PATH + PreToolUse hook)把 `codegraph` CLI 藏起來。這不是潔癖:`CLAUDE.md:142` 記錄過某次 7-repo 的 pass 裡,**15 次 without-arm 有 14 次透過 Bash 摸到了 codegraph**。每次跑完要先看 contamination 那一列,`CLI calls that RETURNED output > 0` 就整批重跑。同樣地 `CODEGRAPH_NO_PROMPT_HOOK=1` 要設,否則 without-arm 白拿結構化 context。

**三、模型必須固定在 Sonnet。** `CLAUDE.md:143` 寫死 `--model sonnet --effort high`,永遠不用 Opus/Fable。第二個理由比省錢重要:Sonnet 是**刻意設定的下限模型** —— 強模型的 tool-use 能力會掩蓋掉 salience 與 sufficiency 的問題。在 Sonnet 上站得住的設計能往上通用到所有 host,只在 Opus 上有效的則無法往下通用到多數使用者實際在用的 agent。

### 用在這個 PR 上的結構性問題

**A/B 在方法論上無法歸因。** playbook 的粒度是 per language × framework;這個 PR 一次上 11 種語言、7 個 synthesizer、4068 行。就算跑出漂亮的數字,也無從知道 delta 來自 JNI、AIDL、device tree 還是 resource。反過來,如果數字難看,也無從知道是哪個 channel 拖累的。

**這是拆 PR 的技術理由,不只是 review 便利性。** 建議的切法:

1. 基礎建設(node/edge kind、Rust 鏡像、`aosp` profile + gate、語言登記,**不含 synthesizer**)
2. JNI —— 自閉合、驗證成本最低,適合當第一個帶數字的 PR
3. 建置圖(Blueprint / Make / Bazel + `enrich`)
4. AIDL/Binder + VINTF
5. Device tree
6. Resource / RRO

每個 PR 帶自己的 probe + A/B 一列進 coverage matrix。

### probe 先於 A/B,而且 probe 是更划算的一關

`CLAUDE.md:139` 的順序是:確定性 probe → agent A/B。這個順序在這個 PR 上特別重要,因為 **probe 能否連通是省 token 的前置條件**。flow 在圖裡如果根本沒連起來,agent 一定會退回 Read/Grep,A/B 不用跑就知道結果。

probe 要驗三件事:

- flow 端到端連通(`codegraph_explore` 的 Flow 段落顯示完整路徑,沒有斷點)
- **沒有 node 爆炸**(`select count(*) from nodes` 在重新索引前後穩定)
- 合成邊的**精確度**抽樣(`select … where provenance='heuristic'`)

第三項在這個 PR 上尤其該做:7 個 synthesizer 全部產出 `provenance:'heuristic'` 的邊,其中好幾個的比對條件很寬鬆。例如 `selinuxBindingSynthesizer` 用 `qualifiedName.startsWith(policy.name.replace(/\*$/, ''))` 做前綴比對,在 `property_contexts` 這種前綴語意的檔案上很容易一個 context 連到上百個 property,而且信心值還標成 `exact`。這正是 precision 抽樣要抓的東西。

### 「partial coverage is WORSE than none」在這個 PR 上的具體位置

`CLAUDE.md:132` 的原則有實測背書:excalidraw 上只加 react-render 一個 hop,Read 次數從基準**上升**到 5–7;補上 jsx-child 完成整條 flow 後才掉到 0–1。

照著程式碼追,這個 PR 有三條 flow 是半截的:

| Flow hop | 狀態 |
|---|---|
| Java `native` method ↔ C/C++ 函式 | ✅ 雙向閉合 |
| AIDL 介面 → 實作類別 | ✅ |
| **AIDL 呼叫端 → 介面**(`IFoo.Stub.asInterface()`) | ❌ **斷** —— 產生的 stub 不在 source tree |
| VINTF manifest → HAL 介面 | ✅ |
| init.rc service → build_target → 原始檔 | ✅(僅到檔案層級,不到 `main()`) |
| device tree `compatible` → driver probe | ⚠️ 邏輯在,但受 review #1 影響,真實 .dts 抓不到節點 |
| layout/manifest `@string/foo` → resource 節點 | ✅ |
| **Java `R.string.foo` → resource 節點** | ❌ **斷** —— 全 repo grep 不到任何 `R.*` 解析 |
| AndroidTest.xml → 測試模組 | ✅ |
| **`include-filter` 的 `DemoClass#works` → 測試類別** | ❌ **斷** —— `#` 沒切開 |
| SELinux context → service/property | ✅ 終端節點,不需下一跳 |

`R.*` 那條最該擔心:「這個 string/layout 在哪被用到」是 Android 最高頻的問題,現在 XML 那半邊有節點、Java 那半邊沒有邊 —— agent 在圖裡看得到 resource 節點存在卻追不到使用端,於是 drill 一次再 grep。這和 react-render 單獨上線的失敗模式是同一個。

**建議**:在補齊那兩條斷點之前,先把 `aidlBinderSynthesizer` 從 `AOSP_GRAPH_SYNTHESIZERS` 拿掉,resource 節點的產生也一併延後。剩下 jni / init-service / hal-vintf / selinux 是自閉合的,可以先上並先拿數字。`CLAUDE.md:111` 的說法是 silent beats wrong。

---

## 第二部分:本機執行計畫

### 環境實測

| 項目 | 實測值 |
|---|---|
| AOSP | `/home/sam/aosp-android-15-r6`,**163 GB** |
| lunch target(從 out/ 推斷) | `aosp_cf_x86_64_wear`,product dir `vsoc_x86_64_only` |
| `out/` | 29 GB(只有 soong bootstrap / ninja / dumpvars) |
| `isAospWorkspace` marker | `.repo/manifest.xml` ✅ / `build/soong` ✅ / `build/make` ✅ —— **三個全中,profile 會自動啟用** |
| Node / npm | v22.22.3 / 10.9.8 ✅(需 >=20 <25;跑 source 需 >=22.5) |
| CPU / RAM | 8 core / 30 GB |
| 磁碟餘量 | 88 GB |

子樹大小(決定索引範圍用):

| 子樹 | 大小 | 覆蓋的 channel |
|---|---|---|
| `system/core` | 16 MB | init.rc、build_target |
| `system/sepolicy` | 31 MB | SELinux |
| `hardware/interfaces` | 117 MB | AIDL / HIDL / VINTF |
| `frameworks/base/core` | 227 MB | Java + JNI + resource XML |
| `packages/modules` | 1.3 GB | — |
| `device` | 9.4 GB | — |

### repo 內建的 `/agent-eval` skill 對 AOSP 不直接適用

`repo/.claude/skills/agent-eval/` 提供了一條 guided 路徑,但它的設計前提和本案不合,有三個落差:

- **它會 clone。** `audit.sh:47` 的流程是 `git clone --depth 1 "$URL"`,輸入是 repo URL,不是本機路徑。對已經存在的 163 GB AOSP checkout 沒有意義。
- **corpus 沒有 AOSP 條目。** `corpus.json` 有 33 個語言分類(TypeScript、Java、Kotlin、C、C++、ArkTS…),**沒有 Android / AOSP**。這個 PR 若要走 skill 的路徑,得先為 AOSP 新增 corpus 條目 —— 而條目要填的 `question` 正是「canonical flow 是什麼」這個尚未回答的問題。
- **prerequisites 沒滿足。** skill 明列需要 `tmux` 3+ 與**已登入的 `claude` CLI**,本機兩者都沒有。

因此 AOSP 的 A/B 應該直接用 `run-all.sh <repo-path> "<question>"`(它吃本機路徑),繞過 `audit.sh` 的 clone 與 corpus 查表。

### 目前擋住的三件事

**1. `claude` CLI 沒安裝 → agent A/B 跑不了。**

`which claude` 沒有結果。`run-all.sh` 與 `ab-new-vs-baseline.sh` 都直接呼叫 `claude -p ... --output-format stream-json`,沒有它就無法產生 token / tool-call 數據。這是「測是否省 token」這個目標的**硬性前提**,而且跑起來會消耗 API 額度(`run-agent.sh` 每個 run 設 `--max-budget-usd 2`,一次完整 A/B 是 2 arm × 2 run × 3 prompt = 12 runs)。安裝與額度是需要人決定的事。

`tmux` 也沒安裝 —— headless arm 不需要它,但 skill 的 interactive(tmux)harness 需要。只跑 headless 的話可以先不管。

**2. 沒有 `module-info.json` → `codegraph aosp enrich` 測不了。**

`out/` 底下找不到 `module-info.json`,只有 `out/soong/module_bp_cc_deps.json` 與 `module_bp_java_deps.json` —— 格式與 `ModuleInfoBuildGraphProvider` 期待的不同,不能直接餵。要測 enrich 需要先在 AOSP tree 裡跑 `m module-info`,在 8 core 上大約要 20–60 分鐘的 Kati product config。

同理沒有 `compile_commands.json`,所以 review 第 3 項(compile_commands 逐檔範圍化的 regression)在這個 checkout 上也無法用真實資料重現 —— 但它可以用 unit test 覆蓋,不需要 AOSP。

**3. 沒有 kernel 原始碼 → device tree 與 Kconfig 兩個 channel 完全測不到。**

`kernel/` 底下只有 `configs/`、`prebuilts/`、`tests/`。AOSP platform manifest 不含 kernel source,要另外 `repo init` 一個 kernel manifest(`common-android15-*`)。也就是說 review 第 1 項(device tree 巢狀節點遺失)在這台機器上**無法用真實 .dts 驗證**,除非另外拉 kernel tree。

### 可以現在就跑的:確定性 probe

這一關不需要 `claude` CLI、不花 API 額度,而且是省 token 的前置條件 —— flow 沒連通就不可能省。

**索引範圍的建議**:不要一次索引 163 GB。先用 `hardware/interfaces` + `system/core` + `frameworks/base/core` 這幾個子樹,它們覆蓋 jni / aidl / vintf / init / resource 五個已閉合或半閉合的 channel,總計約 360 MB,索引時間可控,而且能直接驗證上面那張 flow 表。

要量的三件事,對應 `CLAUDE.md:139`:

1. **連通性** —— 用 `probe-explore.mjs` 對 AIDL 的 canonical flow 下符號袋,看 Flow 段落是否端到端
2. **node 爆炸** —— 索引前後 `select count(*) from nodes` 比對
3. **合成邊 precision** —— `select * from edges where provenance='heuristic'` 抽樣,重點看 `synthesizedBy='aosp-selinux-binding'` 與 `'aosp-aidl-binder'` 的扇出

同時這一輪也能**直接驗證 review 裡的幾項發現**,不需要另外設計實驗:

| review 項次 | 在真實 AOSP 上怎麼驗 |
|---|---|
| #1 device tree 巢狀節點 | 需另拉 kernel tree,本機無法 |
| #2 註解裡的撇號 | `grep -rl "'" --include=Android.bp` 找含撇號註解的檔案,比對抽出的 module 數 |
| #4 `<configuration>` 誤判 | AOSP 內的 `pom.xml` / 非 Android XML,看有沒有多出 `build_target` 節點 |
| #5 ref metadata 沒落地 | 索引後 `select * from unresolved_refs` 確認 variant 資訊確實不存在 |
| #6 `attr()` 後綴誤配 | 找含 `layout_name=` / `superclass=` 的 manifest,比對節點名稱 |
| #12 `lineAt` 二次方 | 對 `frameworks/base/core/res/res/values/` 的大檔計時 |
| #13 aidlBinder 二次方 | `hardware/interfaces` 全量索引的 resolution 階段耗時 |

### 建議順序

1. **先修 review 的 P0**(#3 compile_commands、#1 device tree、#2 braceEnd),再測 —— 目前 #1 讓 device tree channel 等於死碼,#2 讓 Android.bp 抽取隨機截斷,在這個狀態下測出來的數字沒有參考價值
2. **加上 profile gate**(把 `synthesizeAospEdges` 收進 `isAospProfileEnabled`),讓「非 AOSP 專案不受影響」變成可驗證的事實而不是承諾
3. **跑 probe**,拿連通性 + node 數 + precision 三組數字
4. probe 過了再決定要不要裝 `claude` CLI 跑 A/B —— probe 不過的話 A/B 一定難看,先省下那筆額度

---

## 附:本文的執行狀態

**已完成**

- `npm ci` ✅
- `npm run build` ✅ —— `dist/bin/codegraph.js` 產出,`dist/extraction/wasm/` 共 31 個 `.wasm`,包含新增的 `tree-sitter-starlark.wasm` 與 `tree-sitter-devicetree.wasm`(印證 `CLAUDE.md:30` 的 copy-assets glob 有正確帶上新資產)
- 環境量測(AOSP 路徑 / 大小 / marker / 子樹 / 工具鏈)

**未執行**

- 未跑 `npm test` / `vitest`
- 未索引 AOSP —— 上述所有數字皆為環境量測,**不是** codegraph 的執行結果
- 未跑任何 probe
- 未跑任何 agent A/B —— `claude` CLI 不存在

任何後續實際跑出的數字應該覆寫本文第二部分,並依 `CLAUDE.md:145` 寫進 `docs/design/dynamic-dispatch-coverage-playbook.md` 的 coverage matrix。
