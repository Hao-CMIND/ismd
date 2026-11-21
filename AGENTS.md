# Git Branch / Commit 自動化規範

完成已授權的程式碼、文件、設定檔或其他專案內容修改後，Agent 應依本規範：

1. 判斷本次任務所屬模組
2. 自動選擇正確 Git Branch
3. 在安全條件允許時自動建立或切換 Branch
4. 完成修改
5. 執行必要測試
6. 建立最小可驗證 Git Commit
7. 回報 Branch、測試與 Commit 資訊

---

# 1. 核心原則

Git Folder、Branch、Commit 分別代表不同邊界：

```text
Folder
= 模組 / Package 邊界

Branch
= 短期開發工作單位

Commit
= 最小可驗證變更
```

不得將某個資料夾永久綁死在某個 Branch。

但 Agent 應依照：

```text
本次主要修改範圍
+
任務目的
```

自動判斷最適合的 Branch。

---

# 2. 基礎 Branch 架構

主要整合 Branch：

```text
dev
```

穩定發布 Branch：

```text
main
```

Phase 5 Feature Branch：

```text
feat/filter-separation

feat/js-cli-api

feat/vite-plugin

feat/webpack-adapter

test/bundler-stability
```

Feature Branch 原則上從：

```text
dev
```

建立。

完整流程：

```text
main
  │
  ▼
dev
  │
  ├─ feat/filter-separation
  │
  ├─ feat/js-cli-api
  │
  ├─ feat/vite-plugin
  │
  ├─ feat/webpack-adapter
  │
  └─ test/bundler-stability
```

Feature 完成後：

```text
Feature Branch
↓
由使用者決定是否 Merge
↓
dev
↓
Full Regression
↓
main
```

---

# 3. Agent 可自動執行的 Git 操作

Agent 在符合安全條件時，可以自行執行：

```bash
git status
git status --short
git branch --show-current

git switch <existing-allowed-branch>

git switch -c <new-allowed-branch> dev

git add -- <specific-files>

git diff
git diff --cached
git diff --cached --name-only

git commit
```

Agent 可以：

```text
自動判斷 Branch
自動建立允許的 Feature Branch
自動切換允許的 Branch
自動 Stage
自動 Commit
```

---

# 4. 永遠不得自行執行的 Git 操作

除非使用者明確授權，Agent 不得自行：

```bash
git merge
git rebase
git cherry-pick

git push

git reset
git restore
git clean

git branch -d
git branch -D
```

也不得自行進行：

```text
force push
history rewrite
stash drop
discard changes
```

---

# 5. Branch 自動判斷規則

Agent 應優先根據：

```text
實際修改的主要模組
```

決定 Branch。

不是單純依照：

```text
目前所在資料夾
```

也不是只依照：

```text
使用者描述中的關鍵字
```

---

# 6. Rust Compiler 修改

若本次工作主要修改：

```text
ismd/
```

例如：

```text
Parser

Lexer

AST

Oxc Arena

ExpressionStore

TemplateStore

BlockOverlay

CompileBundle

CompilerSession

Dependency DAG

Cache

Incremental Compile

Render Engine

Codegen

Rust / N-API compiler core

Compiler performance

Compiler memory layout

Compiler integration
```

Agent 應自動切換：

```text
dev
```

例如：

```text
目前 Branch:
feat/vite-plugin

使用者要求：
修改 ismd/crates/ismd_compiler/src/lib.rs
```

Agent 應先檢查 working tree。

若安全：

```bash
git switch dev
```

再進行修改。

---

# 7. Rust Compiler 的特殊例外

如果 Rust 修改是某個 Feature 明確不可分割的一部分，且該 Feature Branch 已經被允許修改 Compiler Core，則可留在該 Feature Branch。

目前只有：

```text
feat/filter-separation
```

允許同時修改：

```text
ismd/
packages/filters/
```

例如 Filter API boundary：

```text
ismd/
+
packages/filters/
```

可以在：

```text
feat/filter-separation
```

完成。

---

# 8. Filter 修改

若主要修改：

```text
packages/filters/
```

或工作內容屬於：

```text
Filter Core

FilterExecutor

jstransformer

Filter Adapter

Filter compatibility

Filter boundary
```

Agent 應切換：

```text
feat/filter-separation
```

如果 Branch 不存在：

```bash
git switch dev
git switch -c feat/filter-separation
```

---

# 9. JS API / CLI 修改

若主要工作屬於：

```text
JS API

Node API

Compiler JS binding

CLI

Command line interface

compile()

compileFile()

CompilerSession JS interface

N-API exposed API
```

應切換：

```text
feat/js-cli-api
```

主要允許範圍：

```text
ismd/

packages/cli/

JS API 相關 tests/

JS API 相關 docs/
```

如果：

```text
packages/cli/
```

尚不存在，可以在此 Branch 建立。

---

# 10. Vite 修改

若本次修改：

```text
packages/vite/
```

或工作內容屬於：

```text
Vite Plugin

Vite Adapter

Vite Dev Server

Vite HMR

Vite transform

Vite load

Vite resolveId

Vite CompilerSession

Vite Watcher

Vite dependency invalidation

Vite 8 compatibility
```

Agent 必須自動切換：

```text
feat/vite-plugin
```

例如：

```text
使用者：
修改 Vite adapter

目前 Branch：
dev
```

應執行：

```bash
git status --short
git switch feat/vite-plugin
```

如果 Branch 尚不存在：

```bash
git switch dev
git switch -c feat/vite-plugin
```

---

# 11. Vite Branch 修改限制

在：

```text
feat/vite-plugin
```

主要允許修改：

```text
packages/vite/

tests/vite/

benchmarks/vite/

docs 中與 Vite 直接相關內容
```

不得因方便直接修改：

```text
ismd/

packages/webpack/
```

如果開發 Vite 時發現：

```text
Compiler Core API 有問題
```

不得直接順便修改。

應：

```text
停止 Vite Core 修改
↓
回報需要 Compiler Core 調整
↓
切換 dev
↓
完成 Compiler Core 修改與 Commit
```

之後再由使用者決定如何讓：

```text
feat/vite-plugin
```

取得新的 Compiler Core 變更。

Agent 不得自行 Merge / Rebase / Cherry-pick。

---

# 12. Webpack 修改

若本次修改：

```text
packages/webpack/
```

或工作內容屬於：

```text
Webpack Plugin

Webpack Loader

Webpack Compiler

Webpack Watch

Webpack CompilerSession

Webpack dependency invalidation

Webpack HMR-like rebuild

Webpack integration
```

Agent 應自動切換：

```text
feat/webpack-adapter
```

若不存在：

```bash
git switch dev
git switch -c feat/webpack-adapter
```

---

# 13. Webpack Branch 修改限制

在：

```text
feat/webpack-adapter
```

主要允許修改：

```text
packages/webpack/

tests/webpack/

benchmarks/webpack/

Webpack 相關 docs/
```

不得順便修改：

```text
ismd/

packages/vite/
```

如果需要 Compiler Core 修改：

```text
切回 dev 處理
```

不得將 Core API 變更偷偷包含在 Webpack Commit。

---

# 14. Bundler Stability 修改

如果工作主要是：

```text
Vite + Webpack 共用整合測試

長時間 Watch 測試

file rename

atomic save

delete / recreate

dependency invalidation

memory stability

long-running session

cross-bundler regression
```

應切換：

```text
test/bundler-stability
```

允許範圍：

```text
packages/vite/

packages/webpack/

tests/

benchmarks/

相關 docs/
```

但此 Branch 應以：

```text
整合測試
穩定性修正
regression
```

為主。

不是新增大型 Vite / Webpack Feature 的主要 Branch。

---

# 15. dev 的定位

```text
dev
```

是 Compiler Integration Branch。

主要處理：

```text
Rust Compiler Core

Compiler API

CompilerSession

共用 Parser / AST / Render

Cache

Incremental compile

Cross-package regression

Feature merge 後 integration fix

Phase integration

Compiler performance
```

一般獨立 Feature：

```text
Filter
Vite
Webpack
CLI
```

仍優先使用自己的 Feature Branch。

不要將所有工作全部直接堆在：

```text
dev
```

---

# 16. main Branch 規則

```text
main
```

視為：

```text
穩定 / 發布 Branch
```

Agent 在：

```text
main
```

時，原則上不得直接修改或 Commit。

若收到一般開發工作：

```text
先判斷工作類型
↓
自動切換至正確 Branch
```

例如：

```text
目前：
main

要求：
修改 Vite plugin
```

安全條件通過後：

```bash
git switch feat/vite-plugin
```

而不是在：

```text
main
```

直接修改。

只有使用者明確說：

```text
直接修改 main
```

才能在 main Commit。

---

# 17. 自動切換 Branch 前安全檢查

任何：

```text
git switch
```

之前，必須執行：

```bash
git status --short
git branch --show-current
```

---

# 18. Working Tree 乾淨

若：

```bash
git status --short
```

沒有任何輸出：

```text
Working Tree Clean
```

Agent 可依規則自動切換 Branch。

---

# 19. Working Tree 有修改

如果存在：

```text
Modified
Added
Deleted
Renamed
Untracked
Staged
```

必須先判斷這些修改是否：

```text
全部屬於目前 Agent
+
全部屬於剛完成且應 Commit 的同一工作
```

若不是：

```text
不得切換 Branch
```

---

# 20. 使用者既有修改

如果發現：

```text
使用者尚未 Commit 的修改

其他 Agent 修改

未知來源修改

已存在 staged files
```

Agent 不得：

```text
切 Branch
reset
restore
clean
stash
```

應回報：

```text
偵測到既有未提交修改，因此未自動切換 Branch。
```

---

# 21. 不得自動 Stash

Agent 不得為了方便切換 Branch 自動：

```bash
git stash
```

也不得：

```bash
git stash pop
git stash drop
```

除非使用者明確要求。

---

# 22. Branch 不存在時

若目標 Branch 屬於允許清單，但尚不存在：

```text
feat/filter-separation

feat/js-cli-api

feat/vite-plugin

feat/webpack-adapter

test/bundler-stability
```

Agent 可以自動建立。

建立前：

```bash
git status --short
```

必須乾淨。

然後：

```bash
git switch dev
git switch -c <branch>
```

例如：

```bash
git switch dev
git switch -c feat/vite-plugin
```

---

# 23. 未知 Branch

如果目前 Branch 不在：

```text
main
dev
feat/filter-separation
feat/js-cli-api
feat/vite-plugin
feat/webpack-adapter
test/bundler-stability
```

Agent 應：

```text
先判斷本次工作應屬於哪個 Branch
```

如果 Working Tree Clean：

```text
可以切到正確的已允許 Branch
```

如果 Working Tree 不乾淨：

```text
不得切換
```

---

# 24. 新類型 Feature

如果任務明顯不屬於現有 Branch：

例如：

```text
packages/esbuild/

packages/rollup/

新的 formatter package

新的 lint package
```

Agent 不得自行發明永久 Branch 規則。

可以建議：

```text
feat/esbuild-adapter
feat/rollup-adapter
```

但建立前應由使用者確認。

---

# 25. 多模組任務判斷

若一個任務同時涉及：

```text
Rust Compiler
+
Vite
```

不能直接選一個 Branch 全部修改。

應拆解為：

```text
Task A
Compiler Core API
→ dev

Task B
Vite integration
→ feat/vite-plugin
```

並建立不同 Commit。

---

# 26. Cross-Package 修改原則

基本規則：

```text
Core 修改
→ Core Branch

Adapter 修改
→ Adapter Branch
```

例如：

```text
ismd/
+
packages/vite/
```

不應在：

```text
feat/vite-plugin
```

一起 Commit。

應拆分。

---

# 27. 允許的 Cross-Package 例外

以下目前允許：

```text
feat/filter-separation
```

可以同時處理：

```text
ismd/
+
packages/filters/
```

因為 Filter boundary 本身即是跨 Core / Adapter 的 Feature。

---

# 28. Branch 對照表

| 修改內容 | Branch |
|---|---|
| `ismd/` | `dev` |
| Compiler Core | `dev` |
| Parser / Lexer / AST | `dev` |
| Oxc Arena | `dev` |
| ExpressionStore | `dev` |
| TemplateStore | `dev` |
| BlockOverlay | `dev` |
| CompileBundle | `dev` |
| CompilerSession Core | `dev` |
| Compiler Cache | `dev` |
| Compiler Performance | `dev` |
| `packages/filters/` | `feat/filter-separation` |
| FilterExecutor | `feat/filter-separation` |
| jstransformer | `feat/filter-separation` |
| JS API | `feat/js-cli-api` |
| CLI | `feat/js-cli-api` |
| `packages/cli/` | `feat/js-cli-api` |
| `packages/vite/` | `feat/vite-plugin` |
| Vite Plugin | `feat/vite-plugin` |
| Vite HMR | `feat/vite-plugin` |
| Vite Watch | `feat/vite-plugin` |
| Vite 8 compatibility | `feat/vite-plugin` |
| `packages/webpack/` | `feat/webpack-adapter` |
| Webpack Loader | `feat/webpack-adapter` |
| Webpack Plugin | `feat/webpack-adapter` |
| Vite + Webpack stability | `test/bundler-stability` |
| Bundler regression | `test/bundler-stability` |
| Long-running watch test | `test/bundler-stability` |

---

# 29. Branch 選擇優先順序

若同時符合多個規則，依以下優先順序判斷：

```text
1. 是否為明確獨立 Feature

2. 是否涉及 Compiler Core API

3. 是否只屬於單一 Adapter

4. 是否為跨 Bundler integration test

5. 是否為純文件 / benchmark
```

例如：

```text
修改 Vite HMR
```

即使內部會呼叫 Compiler：

```text
仍然屬於 feat/vite-plugin
```

但如果必須修改：

```text
ismd/
```

則 Core 部分應拆至：

```text
dev
```

---

# 30. Docs Branch 判斷

文件不單獨建立 Branch。

Docs 應跟隨其功能：

```text
Compiler docs
→ dev

Filter docs
→ feat/filter-separation

CLI docs
→ feat/js-cli-api

Vite docs
→ feat/vite-plugin

Webpack docs
→ feat/webpack-adapter

Bundler stability docs
→ test/bundler-stability
```

---

# 31. Benchmark Branch 判斷

Benchmark 也跟隨功能：

```text
Compiler benchmark
→ dev

Filter benchmark
→ feat/filter-separation

Vite benchmark
→ feat/vite-plugin

Webpack benchmark
→ feat/webpack-adapter

Cross-bundler benchmark
→ test/bundler-stability
```

---

# 32. Tests Branch 判斷

Test 檔跟隨被測功能。

例如：

```text
tests/compiler/
→ dev

tests/filters/
→ feat/filter-separation

tests/vite/
→ feat/vite-plugin

tests/webpack/
→ feat/webpack-adapter
```

跨 Bundler：

```text
tests/bundler/
```

優先：

```text
test/bundler-stability
```

---

# 33. 核心保護範圍

任何 Branch 都禁止自動修改或 Commit：

```text
raw/compiler/

.ai-handoff/

ismd/target/

node_modules/

dist/
```

以及：

```text
編譯產物

暫存資料

大型 benchmark output

profiling temporary artifacts

temporary JSON dumps
```

除非該檔案本身明確是：

```text
version-controlled fixture

baseline

snapshot

正式 diagnostic report
```

---

# 34. Benchmark / Report 規則

可以依任務 Commit：

```text
benchmark scripts

diagnostic scripts

benchmark baseline metadata

phase diagnostic reports
```

不得因為執行測試順便加入：

```text
target/

dist/

temporary profiling artifacts

臨時 output
```

若無法判斷：

```text
不要 add
```

---

# 35. 多 Agent / Subagent Git 規則

多個 Subagent 可以平行處理：

```text
分析

程式修改

測試

文件
```

但是：

```text
git add

git commit

git switch
```

一律由：

```text
Main Agent
```

負責。

Subagent 不得執行任何：

```text
Git write operation
```

---

# 36. Commit Granularity

一個 Commit 應符合：

```text
可以獨立理解

+

可以獨立測試

+

可以獨立 rollback
```

例如：

```text
Commit 1
建立 FilterExecutor boundary

Commit 2
移出 jstransformer adapter

Commit 3
補 compatibility tests
```

不要：

```text
一個 Commit 同時包含

Compiler
Vite
Webpack
CLI
Benchmark
```

除非它們確實是不可分割的一個變更。

---

# 37. Conventional Commit 格式

Commit Summary：

```text
<type>(<scope>): <繁體中文摘要>
```

常用 scope：

```text
compiler

filters

cli

vite

webpack

bundler

bench

docs
```

例如：

```text
perf(compiler): 降低增量編譯快取查找成本

feat(filters): 分離 jstransformer 執行層

feat(vite): 新增持續性 CompilerSession 整合

feat(webpack): 新增共用 CompilerSession Plugin

test(bundler): 補齊 atomic save 與 rename 測試

docs(compiler): 更新 Phase 5 架構說明
```

---

# 38. Commit Type

允許：

```text
feat

fix

refactor

perf

test

docs

style

chore
```

遵循 Conventional Commits 語意。

---

# 39. Commit Description

Commit Body 使用繁體中文條列。

例如：

```text
feat(vite): 新增 Vite CompilerSession 整合

- Dev Server 啟動時建立持續性 CompilerSession
- Watcher 僅傳送異動檔案
- 使用 Dependency DAG 計算受影響 entry
- 補上 page、include、layout HMR 測試
```

---

# 40. Commit 前流程

每次 Commit 前必須：

```bash
git branch --show-current
git status --short
```

確認目前：

```text
Branch 正確

修改範圍正確
```

---

# 41. Commit 前測試

依修改範圍執行必要測試。

Compiler Core：

```text
cargo test --workspace

Node integration tests

Differential tests
```

效能修改：

```text
相關 benchmark

必要 profiler
```

Vite：

```text
Vite integration tests

Vite HMR tests

Vite build tests
```

Webpack：

```text
Webpack build

Webpack watch

Webpack loader tests
```

Filter：

```text
Filter compatibility tests

Filter integration tests
```

---

# 42. 測試失敗規則

如果必要測試失敗：

```text
不得建立正式 Commit
```

除非使用者明確要求：

```text
保存目前 WIP
```

此時 Commit 必須明確標示：

```text
WIP
```

---

# 43. Staging 規則

只允許精確 Stage：

```bash
git add -- <file1> <file2> <file3>
```

或：

```bash
git add -- "packages/vite/<specific-path>"
```

禁止：

```bash
git add .

git add -A

git commit -a
```

---

# 44. Commit 前 Staged Audit

必須執行：

```bash
git diff --cached --name-only
```

逐一確認：

```text
1. 屬於目前 Branch 的允許範圍

2. 屬於本次任務

3. 沒有使用者修改

4. 沒有其他 Agent 修改

5. 沒有 raw/compiler/

6. 沒有 .ai-handoff/

7. 沒有 target/

8. 沒有 dist/

9. 沒有 temporary output
```

---

# 45. 發現非預期 Staged File

如果 staged 中存在非預期檔案：

```text
停止 Commit
```

Agent 不得自行：

```bash
git reset
git restore
git clean
```

也不得擅自處理使用者原本的 staged changes。

---

# 46. Feature 完成後

Feature 完成並 Commit 後：

```text
保持在目前 Feature Branch
```

不要自動：

```text
切回 dev
```

也不要自動：

```text
Merge
```

---

# 47. Merge 規則

Feature 完成後只回報：

```text
Branch:
feat/vite-plugin

最後 Commit:
<hash>

Tests:
PASS

狀態:
可合併 dev
```

由使用者決定是否 Merge。

只有使用者明確要求：

```text
合併 feat/vite-plugin 到 dev
```

Agent 才可以執行 Merge。

---

# 48. Rebase / Cherry-pick

永遠不得自行：

```bash
git rebase
git cherry-pick
```

只有使用者明確授權才可執行。

---

# 49. Push

即使 Commit 已完成：

```text
不得自動 Push
```

只有使用者明確要求：

```text
Push
```

才能：

```bash
git push
```

---

# 50. 自動 Branch 行為範例

## Rust Compiler

使用者：

```text
修改 TemplateStore
```

Agent：

```text
判定：
Compiler Core

Branch：
dev
```

如果目前是：

```text
feat/vite-plugin
```

且 Working Tree Clean：

```bash
git switch dev
```

---

## Vite

使用者：

```text
修改 Vite plugin
```

Agent：

```text
判定：
Vite Adapter

Branch：
feat/vite-plugin
```

如果目前是：

```text
dev
```

則：

```bash
git switch feat/vite-plugin
```

---

## Webpack

使用者：

```text
修改 webpack loader
```

Agent：

```text
feat/webpack-adapter
```

---

## Filter

使用者：

```text
把 filter 從 compiler 分離
```

Agent：

```text
feat/filter-separation
```

---

## CLI

使用者：

```text
調整 CLI compile command
```

Agent：

```text
feat/js-cli-api
```

---

# 51. 跨 Branch 工作範例

使用者：

```text
修改 CompilerSession API，
並讓 Vite 使用新的 API
```

不得：

```text
全部在 feat/vite-plugin 完成
```

應拆成：

```text
Step 1

dev

修改 CompilerSession API
↓
Test
↓
Commit
```

然後：

```text
Step 2

feat/vite-plugin

修改 Vite Adapter
↓
Test
↓
Commit
```

Agent 不得自行：

```text
Merge

Rebase

Cherry-pick
```

如果 Vite Branch 尚未取得 Compiler Core Commit：

```text
停止並回報需要同步 Branch
```

---

# 52. Phase 5 建議流程

```text
dev
│
├─ feat/filter-separation
│      ↓
│    完成
│
├─ feat/js-cli-api
│      ↓
│    完成
│
├───────────────┬─────────────────┐
│               │
▼               ▼
feat/vite-plugin    feat/webpack-adapter
│               │
│               │
└───────┬───────┘
        ▼
   dev
        │
        ▼
test/bundler-stability
        │
        ▼
   dev
        │
        ▼
 Full Regression
        │
        ▼
       main
```

Vite / Webpack 平行開發前，建議：

```text
Filter boundary

+

JS / CompilerSession API
```

已穩定。

---

# 53. Agent 每次任務的標準流程

```text
收到任務
↓
git branch --show-current
↓
git status --short
↓
分析主要修改範圍
↓
決定 Branch
↓
Working Tree 是否安全？
│
├─ No
│   ↓
│   不切 Branch
│   回報既有修改
│
└─ Yes
    ↓
目標 Branch 是否存在？
│
├─ Yes
│   ↓
│   git switch <branch>
│
└─ No
    ↓
    從 dev 建立
↓
執行修改
↓
執行 Tests
↓
Tests PASS
↓
精確 git add
↓
git diff --cached --name-only
↓
Staged Audit
↓
git commit
↓
回報結果
```

---

# 54. 回覆格式

完成修改與 Commit 後：

```text
本次修改重點：
- <內容>
- <內容>

Tests:
- <測試>: PASS
- <測試>: PASS

Branch:
<目前 Branch>

Branch Selection:
<為什麼本次使用此 Branch>

Commit Summary:
<type>(<scope>): <繁體中文摘要>

Commit Description:
- <內容>
- <內容>

Commit Hash:
<hash>

Push:
未執行

Merge:
未執行
```

---

# 55. 最重要的 Branch 決策規則

```text
改 Rust Compiler Core
→ dev

改 Filter
→ feat/filter-separation

改 JS API / CLI
→ feat/js-cli-api

改 Vite
→ feat/vite-plugin

改 Webpack
→ feat/webpack-adapter

改 Vite + Webpack 共用穩定性測試
→ test/bundler-stability
```

---

# 56. 最終原則

```text
資料夾
負責模組邊界

Branch
負責短期工作邊界

Commit
負責最小可驗證變更
```

Agent 可以：

```text
自動判斷 Branch
自動建立 Feature Branch
自動切換 Branch
自動測試
自動 Commit
```

但不得自行：

```text
Merge

Rebase

Cherry-pick

Push

Reset

Restore

Clean

刪除 Branch

丟棄使用者修改
```

最終目標：

```text
AI 可以自主完成日常 Git 開發流程

但不能自主改變整合歷史或發布狀態。
```