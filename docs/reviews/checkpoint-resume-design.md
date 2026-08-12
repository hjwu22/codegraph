# Checkpoint / resume 設計

寫給下一位審查者。這份文件回答「codegraph 要支援索引中斷後續跑,該怎麼做」,起因是在
AOSP 上驗證時**索引兩度中途死亡、每次都必須從零重來**(一次被 `#850` watchdog 殺掉,
一次是我自己終止的)。

所有數字都是本機實測,環境與方法見
[aosp-verification-on-real-tree.md](./aosp-verification-on-real-tree.md)。

---

## 先釐清現況:比預期好一半,也差一半

### 好的一半:部分狀態不會損壞,也不會被清掉

- **`indexAll` 不會清空資料庫。** `QueryBuilder.clear()`(`src/db/queries.ts:2808`)確實會
  `DELETE FROM` 四張表,但它只由公開 API `CodeGraph.clear()`(`src/index.ts:2056`)呼叫,
  索引流程本身不呼叫。
- **寫到一半的檔案是安全的。** `src/extraction/index.ts:2348` 的註解點明了這個性質:檔案
  記錄是在它的節點寫入**之後**才寫,所以「a partially-stored file has no record and
  re-indexes」。中斷不會留下一個宣稱完整、實際殘缺的檔案。

換句話說,**續跑所需的資料完整性前提已經成立**,不需要重新設計儲存層。

### 差的一半:批次路徑不跳過已完成的檔案

content-hash 的跳過判斷

```ts
const existingFile = this.queries.getFileByPath(filePath);
if (existingFile && existingFile.contentHash === contentHash) {
  return; // No changes
}
```

位於 `src/extraction/index.ts:2354`,而該處屬於 `indexFile` / `indexFiles` 這條**增量路徑**。
`indexAll` 的批次路徑走 parse worker pool + store worker,無條件送出檔案記錄。

**實測**:對已完整索引的 `kernel-eval` 再跑一次 `index`(不加 `--force`)——
**23 秒 vs 首次 29 秒**,且仍印出 `Indexed 6,782 files`。省下的是作業系統快取,不是略過工作。

---

## 最重要的前提:沒有 yield 的 resume 是無限重死迴圈

`#850` watchdog 在主執行緒無回應約 60 秒時殺掉程序。若合成階段仍是同步且不可中斷,
resume 只會讓它**在同一個位置再死一次**,永遠前進不了。

對照組已經在 repo 裡:`synthesizeCallbackEdges` 花了 **732 秒**卻沒有觸發 watchdog,因為它
是 async 且使用 `createYielder`(`src/resolution/cooperative-yield.ts`)。
`synthesizeAospEdges` 是全同步的。

**所以順序是固定的:先讓長時間階段可中斷,再談 resume。反過來做沒有意義。**

---

## 為什麼不能只 checkpoint 解析階段

28,707 檔那次索引的實測階段耗時:

| 階段 | 耗時 | 佔比 |
|---|---:|---:|
| scan | 0.9 s | <1% |
| parse-loop | 139 s | 14% |
| **resolution(含全部合成)** | **846 s** | **85%** |

只 checkpoint 解析階段,救得回 14%。而且規模越大這個比例越糟 —— 合成是超線性的
(`cFnPtr` 子步驟 E 在節點數 ×1.70 時耗時 ×2.30;AOSP 合成在同一區間耗時 ×3.00)。

---

## 三個層次

### Level 0(前提)—— 讓合成階段可中斷

把 `synthesizeAospEdges` 改成 async 並週期性 yield,沿用 `synthesizeCallbackEdges` 已經在用的
`createYielder`。

這一層**本身就有獨立價值**:它解掉實測外推出來的「約 100 萬節點(≈ 5 萬檔)就撞 watchdog」
問題,而那個門檻低到連 `frameworks/`(57,608 檔)都可能踩到。

### Level 1 —— 批次路徑沿用增量路徑的跳過邏輯

把 `:2354` 的 content-hash 判斷帶進 `indexAll` 的批次路徑。

所需資料已齊備:`files` 表有 `content_hash`、`modified_at`、`size`;partial-store 的安全性質
已經成立(見上)。

**價值有限**(只有 14%),但成本也低,而且它讓「重跑一個中斷的索引」從「完全重做」變成
「只做沒做完的部分」,對開發迭代體驗的改善大於對 AOSP 規模的改善。

### Level 2 —— 以 synthesizer 為單位 checkpoint(價值最高)

這是真正該做的一層,而且**現有設計讓它比想像中便宜**:

1. **狀態是可查詢的,不需新簿記。** 每條合成邊都帶 `metadata.synthesizedBy`,所以「哪些
   synthesizer 已完成」可以直接從圖裡查。
2. **重跑是冪等的。** `synthesizeAospEdges` 的註解寫明「persist idempotently through the
   edge unique key」。這代表**不需要記錄「跑到哪個節點」**,只需要記錄「哪個 synthesizer
   整個跑完了」—— 被中斷的那個直接整支重跑即可,不會產生重複邊。

建議形狀:

- 新增 `index_runs` 表:`started_at`、`extraction_version`、`schema_version`、`root_path`、
  `phase`、`completed_synthesizers`(JSON 陣列)、`completed_at`(NULL = 未完成)
- 每個 synthesizer 完成後把它的 id 追加進去並 commit
- 啟動時若存在 `completed_at IS NULL` 且閘門條件相符的 run,跳過已完成的 synthesizer

**以實際發生過的事故估算價值**:第一次 AOSP 索引在解析完成、進入合成後被 watchdog 殺掉。
Level 2 能救回那 10 分 19 秒裡的約 8 分鐘。

### Level 3 —— synthesizer 內部游標

Level 2 的粒度是「一整個 synthesizer」。在 AOSP 規模,單一個 synthesizer 就要跑數小時
(`cFnPtrEdges` 外推 5.7 小時),所以仍可能一次損失大量工作。

要再細,需要三件事同時成立:每個 synthesizer 有**穩定的迭代順序**、**週期性 flush 邊**、
以及**記錄游標**(例如「node id 處理到 X」)。

這是最貴的一層,而且只對少數真正巨大的 synthesizer 值得做。**建議先做 Level 0 → 2,量過
之後再決定要不要 3。**

---

## 兩個必須處理的正確性問題

### 1. resume 的有效性閘門

舊 run 只有在下列全部相符時才可續:

- `extraction_version`(否則會混出半新半舊的圖)
- `schema_version`
- 索引根路徑

任一不符就必須整個重來。這也是為什麼 `index_runs` 要存這些欄位,而不是只存一個 boolean。

### 2. 中斷期間檔案被修改

被跳過的檔案本身可用 `content_hash` 判斷,但真正的風險在**它的依賴**:某個檔案在中斷後
改變,會讓其他檔案先前留下的 unresolved ref 解析結果不同。

好消息是這個機制已經存在:`unresolved_refs.status` 的 `pending` / `failed` 狀態機正是為此
設計的。schema 註解(#1240)說明 `failed` 的列會被保留,好讓後續 sync 在新符號出現時重試。

**resume 可以直接沿用它 —— 把中斷後的收尾當成一次 sync,而不是當成「繼續一次 index」。**

---

## 結論

**codegraph 已經有增量 sync 的全部機件。resume 主要不是「新增功能」,而是「別丟掉部分狀態,
讓 sync 把剩下的做完」。**

前提是先讓合成階段可以被中斷 —— 否則 resume 只會在同一個地方重複死亡。

建議順序與理由:

| 順序 | 工作 | 為什麼是這個順序 |
|---|---|---|
| 1 | Level 0:合成階段 yield | 其餘全部的前提;本身就解掉 5 萬檔的 watchdog 門檻 |
| 2 | Level 2:per-synthesizer checkpoint | 救得回 85% 的時間;冪等性讓它便宜 |
| 3 | Level 1:批次路徑跳過已完成檔案 | 只有 14%,但成本低 |
| 4 | Level 3:synthesizer 內部游標 | 最貴;先量過再決定 |

注意 Level 2 排在 Level 1 前面 —— 直覺會先做解析階段,但實測顯示那是價值最小的一段。
