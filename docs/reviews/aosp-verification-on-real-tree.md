# AOSP 實機驗證紀錄

給下一位審查者:本文記錄在**真實 AOSP 與 kernel 原始碼**上跑出來的量測,用來驗證
`feat/android-aosp-support`(`f3e49ca`)與其修正 `fix/aosp-review-findings`(`5edfb69`)。

每一項都標明**證據等級**:

- **M** — 有實測數字(修正前/後皆量過)
- **I** — 只做過程式碼檢視,未執行
- **N** — 未測試

不要把 I 或 N 當成 M。

---

## 這個分支包含什麼

| Commit | 內容 | 誰寫的 |
|---|---|---|
| `4bed4c7` | 原始 code review(15 項發現) | review agent |
| `8d8d2fd` | Agent A/B 驗證計畫與方法論意見 | review agent |
| `5edfb69` | 15 項發現的修正 | 另一位 agent(額度用罄) |
| `55046ef` | AIDL/HIDL/Proto 註解遮蔽修正 | 接手的 review agent |
| `eb587c5` | 併入 review 分支 | 接手的 review agent |

`55046ef` 依賴 `5edfb69` 引入的 `maskComments` helper,**不能單獨 cherry-pick**。

建議合併順序:`5edfb69` → `55046ef`。兩份 docs commit 是審查紀錄,合不合併由你決定。

---

## 測試環境

| 項目 | 值 |
|---|---|
| AOSP | `/home/sam/aosp-android-15-r6`,android-15-r6,**163 GB** |
| Kernel | `/home/sam/kernel-common`,common-android15-6.6,**19 GB**,4,886 個 .dts/.dtsi |
| 索引標的 | `hardware/interfaces` + `system/core` + `system/sepolicy` 的**複本**,274 MB / 25,159 檔 |
| Node / CPU / RAM | v22.22.3 / 8 core / 30 GB |

**AOSP 原樹全程唯讀。** 索引跑在 `/home/sam/codegraph/aosp-eval`(複本 + `codegraph.json`
強制 `aosp.enabled=true`),避免把 `.codegraph/` 寫進 163 GB 的 checkout。

AOSP 全樹規模(供「索引整個 AOSP」的估算用):

| 指標 | 數值 |
|---|---|
| 全部檔案(排除 `.repo` / `out`) | 1,322,896 |
| 副檔名可索引的原始檔 | 846,528 |
| 其中 `external/` + `prebuilts/` | 547k(**65%**,全為第三方) |
| 平台程式碼(frameworks/packages/cts/hardware/system/libcore/device/art/bionic) | ~209k |
| `.aidl` 中位於 `aidl_api/`(凍結版本快照) | 6,372 / 8,342(**76%**) |

---

## M — 實測驗證的修正

### #1 Device Tree 巢狀節點(120 個真實 kernel .dts/.dtsi)

| | 修正前 | 修正後 |
|---|---|---|
| 原始碼 `compatible=` 次數 | 1,970 | 1,970 |
| 抽出帶 `compatible` 的 device 節點 | 534 | **1,845** |
| 遺失率 | **72.9%** | **6.3%** |
| 有遺失的檔案 | 109/120 | 78/120 |

最極端的 `qcom/sm6115.dtsi` 修正前宣告 426 個節點只抽出 13 個(全部掛在 `soc@0 {}` 底下)。

**效能沒有反噬**:120 檔共 165 ms,最大的 112 KB `sc7180.dtsi` 只花 16 ms。原始 review 擔心
移除 `nodeRe.lastIndex` 跳躍會造成二次方掃描 —— 實測未發生,`topLevelBraceText` 的遮蔽做法
同時解決了「父節點繼承子節點 `compatible`」這個原始 review 沒發現的正確性問題。

殘留 6.3% 未追根究柢(可能來自 `__overlay__` 區塊與 `&label {}` 覆寫語法)。

### #2 Android.bp 註解撇號截斷(1,321 個真實 Android.bp)

| | 修正前 | 修正後 |
|---|---|---|
| 抽出數 < 宣告數的檔案 | 7 | 0 |
| 遺失 module 總數 | **50** | **0** |
| `system/core/healthd/Android.bp` | 21 → **1** | 21 → **21** |

成因與 review 預測逐字吻合:`healthd/Android.bp:16` 的
`// libraries. Clients don't need to link to these.`,撇號位於第一個 module 的
`shared_libs` 陣列內註解中,`braceEnd` 開啟假字串狀態後一路吃到檔尾。

修正後量到的「4 個殘留」經查證是**量測腳本的誤判** —— `name: "native-test-timeout"` 是
`test_options` 內的巢狀屬性,不是 module。實際遺失為 0。

### #5 Ref metadata 落地

修正前 `unresolved_refs` 欄位:`id, from_node_id, reference_name, reference_kind, line, col,
candidates, file_path, language, status, name_tail` —— 無 `metadata`。

修正後索引實測:67 筆 ref 帶 metadata,內容如 `{"glob":true,"confidence":"strong"}`。

### #13 aidlBinderSynthesizer 效能

修正前的內層工作量(用實測節點數計算):

```
14,528 個 aidl interface × 15,105 個候選 type = 219,000,000 次 predicate
每次非 generatedNames 命中還要 sourceLine() 讀檔
methods.filter() 每個 aidl method 再掃 65,798 個 method 全表
```

第一次索引(修正前建置)在 10m19s 時被 `#850` watchdog 以「主執行緒無回應 ~60 秒」殺掉,
DB 內 `aosp-*` 合成邊掛零。修正後索引 **8m11s 完整跑完,watchdog 未觸發**。

`synthesizeAospEdges` 的實際耗時可從 phase timing 反推:
`callback-synthesis: 336504ms` 減去 `dedupe-merge` 約 318s,AOSP 合成約 **6 秒**。

> **歸因更正**:本次驗證中途曾推測卡死來自 `selinuxBindingSynthesizer`(它未被修正,
> 且 20,231 contexts × 1,534 services+properties = 31M 次比對)。**該推測是錯的** ——
> selinux 產出 2,157 條邊且完全沒卡。原始 review 的 #13 歸因(aidlBinder)才是正確的。

### 新發現:AIDL 抽取器未遮蔽註解(本分支 `55046ef` 修正)

抽驗 `aosp-aidl-binder` 邊時發現一個名為 `is` 的 AIDL interface 節點。追到
`hardware/google/av/media/eco/aidl/.../IECOService.aidl:24`:

```
 * Binder interface for ECO (Encoder Camera Optimization) service.
```

正則抓到註解中的 `interface for`,產生名為 `for` 的 interface 節點。

AIDL 特別脆弱,因為它的宣告**不強制以 `{` 結尾**(`parcelable Request;` 合法),所以沒有
任何東西擋住註解匹配。HIDL 與 Proto 的正則要求 `{`,因此僥倖為 0% 噪音。

| | 修正前 | 修正後 |
|---|---|---|
| AIDL interface 節點是註解噪音 | **13,336 / 14,528(91.8%)** | **0 / 1,181** |
| AIDL 全部宣告節點噪音(3,000 檔取樣) | 58.4% | **0.0%** |
| 節點總數 | 342,108 | **327,636**(−14,472) |
| 邊總數 | 699,911 | **677,612**(−22,299) |
| `aosp-aidl-binder` 邊 | 14,030 | 7,884 |

最常見的垃圾名稱:`is` 6,437、`module` 6,369、`and` 115、`in` 111、`or` 100 —— 前兩名來自
AOSP `aidl_api/` 的制式檔頭(「the aidl_**interface** module type」、
「this **interface** is ...」)。

這正是 `CLAUDE.md:139` 要求 probe 檢查的 **node explosion**。

> **數字更正**:驗證過程中曾回報「90.3% 的 `aosp-aidl-binder` 邊 source 是垃圾節點」。
> 該查詢以「名稱小寫開頭」判定垃圾,但未排除 `kind='method'` 的來源 —— AIDL 方法名本就是
> camelCase(來源組成實為 interface 478、method 2,367),因此該比例**無效**。舊 DB 已被
> 覆寫,無法重算。可靠的數字是本表其餘各列。

---

## M — 合成邊產出與精確度

修正後索引(22,830 檔)的合成邊:

| synthesizedBy | 邊數 | 備註 |
|---|---:|---|
| `aosp-aidl-binder` | 7,884 | 抽樣品質高(見下) |
| `aosp-selinux-binding` | 2,157 | 未做精確度抽樣 |
| `fn-pointer-dispatch` | 1,820 | 既有 synthesizer |
| `cpp-override` | 671 | 既有 |
| `aosp-init-service` | 255 | |
| `aosp-hal-vintf` | 31 | 全為 HIDL |
| `interface-impl` | 2 | 既有 |
| `aosp-jni` | **1** | 此子樹僅 371 個 java 節點,**未有效測試** |
| `aosp-devicetree-driver` | 0 | 此子樹無 kernel source,**未測試** |
| `aosp-devicetree-binding` | 0 | 同上 |

`aosp-aidl-binder` 隨機抽樣 10 條,全部正確:

```
IBluetoothHci  -> BluetoothHci   [cpp] default/bluetooth_hci.h
ICanController -> CanController  [cpp] default/CanController.h
IGnssCallback  -> GnssCallback   [cpp] functional/gnss_hal_test.h
IPreparedModel -> PreparedModel  [cpp] hal/PreparedModel.h
IRadioConfigIndication -> RadioConfigIndication [cpp] default/RadioConfigIndication.h
ISensors       -> HalProxyV2_1   [cpp] include/HalProxy.h
```

扇出最大者為 `IDevice` 15 條,且同名節點重複多份 —— 那是 `aidl_api/` 凍結快照造成的
(`IDevice.aidl` 在樹中出現 6 次)。

---

## M — Canonical flow 連通性(省 token 的前置條件)

`CLAUDE.md:139` 要求 agent A/B 之前先做確定性 probe。以下不需 `claude` CLI、零成本。

**Flow — init.rc service → build_target → 原始檔**

| 指標 | 數值 |
|---|---|
| init.rc service 取樣 | 277 |
| 能連到 build_target | **255(92%)** |
| 再往下連到原始檔/符號 | **203(73%)** |

**Flow — 跨語言 3 跳可達性**(grep 做不到的部分)

| 起點 | 3 跳可達節點 | 語言分佈 |
|---|---:|---|
| `IBluetoothHci` | 136 | aidl 32 / cpp 104 |
| `ICanController` | 228 | aidl 198 / cpp 30 |
| `IPreparedModel` | 728 | aidl 136 / cpp 589 / c 1 / blueprint 2 |

**Flow — VINTF → 介面**:31 條,抽樣如
`android.hardware.atrace::IAtraceDevice/default -> IAtraceDevice [hidl]`,正確。

結論:AIDL→實作、init.rc→build_target→原始檔、VINTF→介面 三段都連通。這是「codegraph 能
省 token」的**必要條件**,但不是充分條件 —— 充分性要靠 agent A/B。

probe 腳本保存於 `/tmp/.../scratchpad/flow-probe.mjs`(非持久),邏輯已記錄於本文。

---

## M — 第二輪:擴大索引後的 channel 驗證

第一輪的索引子樹(`hardware/interfaces` + `system/core` + `system/sepolicy`)缺 Java 與
kernel 原始碼,因此 JNI 與兩個 Device Tree channel 等於沒被測到。第二輪補上。

### Stage A — 加入 `frameworks/base` 的 JNI 配對子樹

加入 `core/java`(83 MB)+ `core/jni`(4.4 MB)+ `services/core/jni`(1.5 MB)。

| | 前 | 後 |
|---|---|---|
| 索引檔案 | 22,830 | 28,707 |
| 節點 / 邊 | 328k / 678k | **555,686 / 1,284,602** |
| java 節點 | 371 | 207,236 |
| `aosp-jni` | **1** | **615** |
| 索引時間 | 8m11s | **16m37s** |
| watchdog | 未觸發 | 未觸發 |

JNI 抽樣 14 條全部正確,兩種偵測路徑都涵蓋:

```
android.os::Process::createProcessGroup   -> android_os_Process_createProcessGroup   exact  (名稱編碼)
AssetManager::nativeAssetDestroy          -> NativeAssetDestroy                      exact  (JNINativeMethod 表)
SurfaceControl::nativeSetCornerRadius     -> nativeSetCornerRadius                   exact
GraphicsEnvironment::setDriverPathAnd...  -> setDriverPathAndSphalLibraries_native   strong
```

**新發現(未修,屬設計決策):反向 JNI 實質不可用。** 方向分佈是 614 條 java→cpp、
**僅 1 條** cpp→java,但樹中有 89 個檔案同時具備 `FindClass` + `GetMethodID` +
`Call*Method` 三個訊號。以 `frameworks/base/core/jni/android_view_DisplayEventReceiver.cpp`
查證,兩個獨立原因:

```
215–307  env->CallVoidMethod(..., gDisplayEventReceiverClassInfo.dispatchVsync, ...)
389      jclass clazz = FindClassOrDie(env, "android/view/DisplayEventReceiver");
393–404  GetMethodIDOrDie(env, ...clazz, "dispatchVsync", "(JJI)V")
```

1. **三個訊號分屬不同函式。** AOSP 慣例是 registration 函式把 `jclass`/`jmethodID` 快取進
   static struct,callback 函式後來才用快取 ID。`jniSynthesizer` 卻要求三者出現在同一個
   函式 body 內。
2. **AOSP 使用 `FindClassOrDie` / `GetMethodIDOrDie` 包裝函式。** 正則 `\bFindClass\s*\(`
   對不上,且它預期字串字面值是第一個參數,AOSP 的第一個參數是 `env`。

只修原因 2 不會多出任何一條邊。跨函式追蹤快取 static 是設計變更,留給作者決定。正向那
614 條品質很好,且「這個 native 方法實作在哪」本身是完整答案 —— 需要修正的是 CHANGELOG
的 **bidirectional JNI** 宣稱,資料不支持。

### Stage B — kernel Device Tree(獨立索引)

`kernel-eval` = arm64 dts(1,699 檔)+ 10 個 driver 子系統(712 個含 `.compatible` 表的
C 檔)+ Documentation 的 binding schema(3,697 個 yaml),共 6,782 檔,**索引 29 秒**。

| synthesizer | 邊數 | 精確度 |
|---|---:|---|
| `aosp-devicetree-driver` | **11,456** | 抽樣 12 條全對 |
| `aosp-devicetree-binding` | 28,797 → **9,139**(修正後) | 修正前抽樣 12 條僅 1 條正確 |

driver 抽樣:

```
i2c4        qcom,geni-i2c            -> geni_i2c_probe        busses/i2c-qcom-geni.c
dispcc      qcom,sdm845-dispcc       -> disp_cc_sdm845_probe  qcom/dispcc-sdm845.c
pca9450     nxp,pca9450a             -> pca9450_i2c_probe     regulator/pca9450-regulator.c
pmu@90b6400 qcom,sc8280xp-cpu-bwmon  -> bwmon_probe           qcom/icc-bwmon.c
```

扇出最大 12、中位數 2。最高量的 `regulator-fixed`(3,178 條)全部指向
`drivers/regulator/fixed.c` 的兩個函式 —— 正確,只是 device tree 裡固定電壓調節器本來就多。

**新發現(已修,commit `0aa6259`):binding 用通用 compatible 亂配。** Device Tree 的
`compatible` 是**有序清單、最specific 在前**,但 synthesizer 對每個項目都比對,於是尾端的
通用 `arm,primecell`(有 30 個 schema 宣告它)讓每個 PrimeCell 週邊互相配對:

```
gpio15  arm,pl061|arm,primecell  -> serio/arm,pl050.yaml    ❌ GPIO 配到 PS/2
pdma0   arm,pl330|arm,primecell  -> rtc/arm,pl031.yaml      ❌ DMA 配到 RTC
timer2  arm,sp804|arm,primecell  -> coresight-replicator    ❌
```

19,176 / 28,797 = **66.6%** 的邊是靠 `arm,primecell` 建立的。修法:依序取用、命中即停;並
跳過被超過三個 schema 宣告的字串 —— 真實樹的分佈是雙峰的,5,132 個 compatible 中 5,101 個
(99.4%)只對應一個 schema,只有 `arm,primecell`(30)與 `qcom,mdss-dsi-ctrl`(15)超標。
修正後 9,139 條、以 primecell 為證據者 **0** 條、抽樣 12 條全對。

### 這一輪修掉的兩個缺陷屬於同一類

selinux 的 `*` catch-all 與 device tree 的 `arm,primecell`,都是**沒有識別力的通用字串被當
成識別證據**。兩者都造成約 66–70% 的邊是錯的,且都被標為 `confidence: 'exact'`。值得在
review 其餘 synthesizer 時當成一個檢查項:這個比對鍵有沒有可能是通用值?

---

## I — 僅程式碼檢視,未執行驗證

- **#3** compile_commands 逐檔範圍化:`scoped && scoped.length > 0 ? scoped : index.all`
  的 fallback 正確。本 checkout 無 `compile_commands.json`,**未用真實資料重現**。
- **#4** `isAndroidSemanticXml` 收斂為 Android 路徑/檔名標記 + VINTF `type=`。此 AOSP 子樹
  **沒有 pom.xml**,103 個 `tradefed:` build_target 全為真實 AndroidTest.xml —— 因此原始
  發現與其修正皆**未在真實資料上被證實或推翻**,需要 Maven 專案才驗得到。
- **#6 #7 #8 #9 #10 #11 #12 #14** 逐項讀過 diff,語意正確。
- **#11** 的處理誠實:舊的「loads the pinned WASM grammars」測試被換成
  `expect(await readGrammarWasmBytes(['starlark','devicetree'])).toEqual({})`,而不是留一個
  因 `isGrammarLoaded` 恆真而空過的測試。但 490 KB 的 wasm 仍會打包進 npm 套件。

---

## N — 未測試 / 未解決

1. **Agent A/B 完全未執行。** `claude` CLI 已安裝(2.1.228,harness 用到的 9 個旗標全部
   存在)但**尚未登入** —— headless 回傳 `Not logged in`。A/B 是量測 token 節省的唯一方法。
   `5edfb69` 的 ledger 也誠實標記為 pending authorization。
2. **反向 JNI(cpp→java)實質不可用** —— 見上「Stage A」。未修,屬設計決策。
3. **`aosp-hal-vintf` 只有 31 條且全為 HIDL** —— AIDL 版 VINTF 未被測到。
4. **`aosp-selinux-binding` 修正後的 645 條未再抽驗** —— 已確認 catch-all 那 1,512 條被
   正確移除,但剩下的邊只看過修正前的樣本。
5. **`synthesizeAospEdges` 仍為全同步、無 cooperative yield。** 目前規模只需 ~6 秒,但
   `synthesizeCallbackEdges` 是 async 有 yield 才能安全地花 318 秒。AOSP 合成沒有這層保護,
   規模再放大時 watchdog 風險會回來。
6. **仍無 AOSP profile gate。** `synthesizeAospEdges` 對每個被索引的專案無條件執行。
7. **`aidl_api/` 重複未處理。** 76% 的 .aidl 是凍結版本快照,同一介面每版一份,直接
   膨脹節點數與扇出。是否排除屬產品決策。
8. **`external/` 與 `prebuilts/` 無預設排除** —— 佔 AOSP 原始檔的 65%。

---

## 索引整個 AOSP 的差距

現在有兩個實測點,可以看出**時間是超線性的**:

| 檔案數 | 節點 | 邊 | 索引時間 | `callback-synthesis` |
|---:|---:|---:|---:|---:|
| 22,830 | 327,636 | 677,612 | 8m11s | 336s |
| 28,707 | 555,686 | 1,284,602 | **16m37s** | **752s** |

檔案數 ×1.26,時間 ×2.03。主要成長來自既有的 `cFnPtrEdges`(C 函式指標合成),**不屬於這個
PR**,但它是平台層規模下的主要瓶頸。

以此外推(取 ×1.26 檔案 → ×2.0 時間的比例,而非線性):

| 目標 | 檔案倍數 | 預估 nodes | 預估時間 |
|---|---:|---:|---:|
| 平台層 209k 檔 | 7.3× | ~4M | **遠超 75 分**,可能數小時 |
| 全部原始檔 846k 檔 | 29× | ~16M | 不可行 |

先前文件裡「平台層約 75 分鐘」的線性估算是**低估的**,以此更正。

阻塞項,依嚴重度:

1. **記憶體:`nodesOf()` 抵銷了串流 API 的用意。**
   ```ts
   function nodesOf(context, kind) {
     return context.iterateNodesByKind ? [...context.iterateNodesByKind(kind)] : context.getNodesByKind(kind);
   }
   ```
   `resolution/types.ts:79` 說明 `iterateNodesByKind` 存在的目的是避免撐大 per-kind 陣列
   快取,但 `nodesOf` 拿到 iterator 後立刻 spread 成完整陣列。7 個 synthesizer 各呼叫
   一到三次。在 3.0M nodes 的規模這是致命的。
2. **無 checkpoint / resume** —— 本次驗證中已有兩次索引在中途死亡需從頭重跑。
3. **合成階段無 yield**(見上 N-5)。
4. **`.repo` 下 1000+ 個 git 專案**,`discoverEmbeddedRepoRoots` 在此規模的行為未知。

**務實的目標不是「索引整個 AOSP」,而是「索引 209k 的平台層」。** 那個規模在解決 1 與 3
之後可達。

---

## 重現方式

```bash
npm ci && npm run build
```

```bash
node dist/bin/codegraph.js init <eval-root> && CODEGRAPH_SYNTH_TIMINGS=1 node dist/bin/codegraph.js index <eval-root>
```

`<eval-root>` 為 AOSP 子樹複本加上 `codegraph.json` = `{"aosp":{"enabled":true}}`。
不要直接索引 AOSP 原樹 —— 會寫入 `.codegraph/`。

Agent A/B 的前提與設計見同分支的
[code-review-aosp-ab-test-plan.md](../../code-review-aosp-ab-test-plan.md)。
