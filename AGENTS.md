# Git Commit 規範

每次完成已授權的程式碼、文件、設定檔或其他專案內容修改後，自動建立 Git Commit，並於回覆最後提供本次 Commit 資訊。

## 基本原則

- Git 分支：依目前所在分支決定，不需因切換分支而修改本文件；分支與允許提交範圍對照如下：

  | 目前分支      | 允許自動提交的範圍 |
  | ------------- | ------------------ |
  | `react-pages` | `react/src/` |
  | `vue-pages`   | `vue/src/`         |
  | `scss-lite`   | `vanilla/coreui/lite/`（**僅限 `.scss` 檔案**） |

- 只允許自動提交「目前分支」對應範圍內的異動；範圍以外（含其他分支的資料夾與 `react/md/`）一律不得自動加入或提交。
- **`scss-lite` 分支限定**：目前只允許提交 `.scss` 檔案，任何非 `.scss` 檔案（如 `.md` 文件、`.css` 編譯檔等）一律不得自動加入或提交。
- 目前分支不在上表中時，不自動 Commit，並回報使用者。
- 若本次修改的檔案不屬於目前分支的允許範圍，不得自動切換分支，應停止並回報「請切換到 <對應分支>」。
- 不得自動提交 `.ai-handoff/` 中的 Claude 工作紀錄。
- 根據本次實際修改內容產生 Commit Summary 與 Commit Description。
- Commit Summary 使用 Conventional Commits 格式。
- Commit Summary 與 Description 均使用繁體中文（type 保留英文）。
- Commit Description 使用條列式說明實際異動。
- 不需要每次詢問是否 Commit。
- 不得自動 Push 到遠端儲存庫。

## 多 Subagent 協作時的 Commit 規則

- 多個 subagent 平行或分批處理不同檔案時，**實際的 `git commit` 一律由 main agent 執行**，subagent 本身不得呼叫 git 指令，避免多個 agent 同時操作 git 造成衝突或競爭。
- 每個 subagent 完成一項獨立任務（例如 修改並通過驗證）後，main agent 立即依下方「Git Commit 規範」建立一筆 Commit，不等其他 subagent 一併完成再彙整提交。

## Commit 流程

### 1. 整理本次修改

每次完成開發任務後，先簡短整理實際修改內容，例如：

```text
本次修改重點：
- 新增 ScrollSpy 滾動監聽功能
- 調整 TestDocCard 元件
- 修正頁面錨點定位問題
```

### 2. 檢查與測試

- 執行與本次修改相關的測試。
- 確認沒有因本次修改產生錯誤。
- 如果測試失敗，先處理問題，不得自動 Commit。
- 若沒有可執行的測試，應明確說明。

### 3. 自動建立 Git Commit

先確認目前分支（`git branch --show-current`），並依上方對照表取得本分支的允許範圍 `<允許範圍>`。

只允許暫存指定範圍：

- 若在 `scss-lite` 分支，目前僅允許暫存 `.scss` 檔案，嚴禁暫存 `.md`（如 `css-size-optimization.md`）或其他非 `.scss` 檔案：
  ```powershell
  # 優先暫存本次任務實際修改的特定 .scss 檔案，例如：
  git add <修改的 .scss 檔案路徑>
  # 或使用萬用字元暫存 .scss（注意排除 .md 與其他副檔名）：
  git add -A -- "vanilla/coreui/lite/*.scss" "vanilla/coreui/lite/**/*.scss"
  ```
- 其他分支則依允許範圍暫存：
  ```powershell
  git add -A -- <允許範圍>
  ```

Commit 前必須執行：

```powershell
git diff --cached --name-only
```

確認所有 Staged Files 都符合允許的提交範圍（在 `scss-lite` 分支上，必須確認**全部為 `.scss` 檔案**，嚴禁包含任何 `.md`、`.css` 或其他非 `.scss` 檔案）。

如果發現其他範圍或非 `.scss` 檔案的 Staged Changes，停止提交並回報，不得擅自清除或提交。

確認後自動執行：

```powershell
git commit -m "<type>: <中文修改摘要>" -m "<中文條列式修改說明>"
```

如果沒有符合範圍的異動，則不建立 Commit。

### 4. 回覆格式

完成修改並成功 Commit 後，於回覆最後提供：

```text
本次修改重點：
- <中文修改內容 1>
- <中文修改內容 2>

Commit Summary:
<type>: <中文修改摘要>

Commit Description:
- <中文主要修改內容 1>
- <中文主要修改內容 2>
- <中文主要修改內容 3>

Commit Hash:
<實際 Commit Hash>
```

若 Commit 未成功，應回報原因，不得宣稱已提交。

## 常用 Type

| Type       | 說明                         |
| ---------- | ---------------------------- |
| `feat`     | 新增功能                     |
| `fix`      | 修正錯誤                     |
| `refactor` | 重構，不新增功能也不修正錯誤 |
| `docs`     | 文件修改                     |
| `style`    | 格式調整，不影響程式邏輯     |
| `chore`    | 專案設定、建置、維護         |
| `test`     | 測試相關                     |
| `perf`     | 效能最佳化                   |

## 撰寫原則

- Commit Summary 應簡潔、明確。
- Commit Description 應使用條列式。
- 說明實際修改的檔案、功能與行為。
- 不要只寫「更新檔案」或「調整內容」。
- 若修改沒有影響既有流程，也要明確說明。
- 一項獨立完成的開發任務原則上建立一筆 Commit。
- 避免將多個無關的修改混在同一個 Commit。

## 禁止事項

- 在 `scss-lite` 分支上，不得提交任何非 `.scss` 檔案（如 `.md` 文件、`.css` 編譯檔等）。
- 不得使用不帶路徑限制的 `git add .` 或 `git add -A`。
- 不得使用 `git commit -a`。
- 不得自動提交不相關的 Staged Changes。
- 不得自動執行 Git Push、Reset、Rebase 或 Clean。
- 不得自行修改其他工作者的 Commit。
- 不得為了建立 Commit 而修改無關檔案。

## Claude 交接期間的例外

目前正在進行 Claude Code → Gemini 交接。

在使用者確認全部 Phase 規劃，以及回答 Claude 最後尚未確認的問題之前：

- 只允許讀取 Claude 歷史紀錄。
- 不得修改程式碼。
- 不得自動建立 Commit。
- 不得自行開始下一個 Phase。

使用者明確確認可以開始開發後，才啟用上述自動 Commit 流程。
