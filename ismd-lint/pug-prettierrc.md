# Pug Prettier 設定說明

本文件說明 `@prettier/plugin-pug` 的 **26 個 Pug 選項**，以及前面設定範例中使用的 **5 個 Prettier 共用設定**。每個項目列出用途、可設定值、預設值及範例。

查核日期：2026-11-11。依據官方文件與本次讀取的官方原始碼整理；此日期不是套件發布日期，也不代表已檢查你專案目前安裝的版本。[官方選項清單][pug-index]

## 閱讀方式

本文件沿用你指定的格式：**固定字串選項以陣列列出，索引 `[0]` 放官方預設值**。

```json
{
  "pugClassNotation": ["literal", "attribute", "as-is"]
}
```

這表示預設是 `"literal"`，另外可以選 `"attribute"` 或 `"as-is"`。上述陣列是文件的選項清單；正式 `.prettierrc` 應選擇單一值：

```json
{
  "pugClassNotation": "literal"
}
```

請區分三種情況：

| 類型 | 文件中的表示方式 | 正式設定如何填寫 |
| --- | --- | --- |
| 固定字串列舉 | 例如 `["always", "as-needed", "none"]` | 選一個字串，例如 `"always"` |
| 原本就接受陣列 | 例如 `plugins`、`pugSortAttributesBeginning` | 保留陣列，可以放多個項目 |
| 自訂正規表示式 | `pugWrapAttributesPattern` | 填一個字串；沒有能完整列出的固定選項 |

`pugArrowParens` 是特例：它的預設值是 `null`，所以選項清單寫成 `[null, "always", "avoid"]`。本文件中的數字及布林預設值也採官方預設；先前範例的行寬 `100`、換行門檻 `3` 是自訂範例，並非官方預設。[通用選項定義][pug-common]

## 一、完整選項對照

這份 JSON 用來查閱全部項目，**不是可直接執行的 `.prettierrc`**。其中 `plugins` 已填入本文件需要的外掛；其他一般值採官方預設，固定字串列舉則將預設放在 `[0]`。第十二節另提供可直接使用的正式設定。

```json
{
  "plugins": ["@prettier/plugin-pug"],

  "printWidth": 80,
  "tabWidth": 2,
  "singleQuote": false,
  "semi": true,

  "pugPrintWidth": -1,
  "pugTabWidth": -1,
  "pugUseTabs": null,
  "pugSingleQuote": null,
  "pugSemi": null,
  "pugBracketSpacing": null,
  "pugBracketSameLine": null,
  "pugArrowParens": [null, "always", "avoid"],

  "pugAttributeSeparator": ["always", "as-needed", "none"],
  "pugWrapAttributesThreshold": -1,
  "pugWrapAttributesPattern": "",
  "pugPreserveAttributeBrackets": false,
  "pugClosingBracketIndentDepth": 0,

  "pugSortAttributes": ["as-is", "asc", "desc"],
  "pugSortAttributesBeginning": [],
  "pugSortAttributesEnd": [],

  "pugClassNotation": ["literal", "attribute", "as-is"],
  "pugIdNotation": ["literal", "as-is"],
  "pugClassLocation": ["before-attributes", "after-attributes"],
  "pugExplicitDiv": false,

  "pugEmptyAttributes": ["as-is", "none", "all"],
  "pugEmptyAttributesForceQuotes": [],

  "pugCommentPreserveSpaces": ["keep-all", "keep-leading", "trim-all"],
  "pugPreserveWhitespace": true,

  "pugFramework": ["auto", "vue", "svelte", "angular"],
  "pugSingleFileComponentIndentation": false
}
```

來源：[Prettier 共用選項][prettier-options]、[Pug 選項清單][pug-index]。各項定義及來源在下方逐項列出。

## 二、Prettier 共用設定

這五項屬於 Prettier 本身。本節僅說明先前範例使用的項目，不是 Prettier 所有設定的完整清單。

### 1. `plugins`

- **用途：** 指定要載入的 Prettier 外掛。
- **型別：** 陣列；本範例放入套件名稱字串。
- **本文件設定：** `["@prettier/plugin-pug"]`，用來啟用 Pug 格式化；這不是 Prettier 自動預載的清單。

```json
{
  "plugins": ["@prettier/plugin-pug"]
}
```

這個陣列內的項目會一起載入，不是「選一個」的可選值清單。[來源：官方使用指南][pug-guide]

### 2. `printWidth`

- **用途：** 設定各語言格式器的換行參考寬度。
- **可設定值：** 整數，常見為 `80`、`100`、`120`。
- **官方預設：** `80`。
- **先前範例：** `100`。

```json
{
  "printWidth": 100
}
```

這是排版目標，不是每一行都不得超過的硬性上限。例如長網址、長字串仍可能超過設定寬度。Pug 沒有另設 `pugPrintWidth` 時，會沿用這個值。[來源：Prettier 選項][prettier-options]、[繼承邏輯][pug-converge]

### 3. `tabWidth`

- **用途：** 設定每層縮排的空格數。
- **可設定值：** 整數，常見為 `2` 或 `4`。
- **官方預設：** `2`。

```json
{
  "tabWidth": 2
}
```

使用空格縮排時，巢狀內容每深入一層增加兩格；Pug 可以再透過 `pugTabWidth` 覆寫。[來源：Prettier 選項][prettier-options]

### 4. `singleQuote`

- **用途：** 對適用此選項的程式碼，設定字串是否優先使用單引號。
- **可設定值：** `true`、`false`。
- **官方預設：** `false`，優先使用雙引號。
- **先前範例：** `true`。

```js
// singleQuote: false
const title = "報價管理";

// singleQuote: true
const title = '報價管理';
```

這是引號偏好，格式器仍會考量字串內容及跳脫字元。Pug 可以另外設定 `pugSingleQuote`，讓 JavaScript 與 Pug 屬性使用不同偏好。[來源：Prettier 選項][prettier-options]、[Pug 覆寫說明][pug-overrides]

### 5. `semi`

- **用途：** 控制 JavaScript 敘述的結尾分號。
- **可設定值：** `true`、`false`。
- **官方預設：** `true`。
- **先前範例：** `false`。

```js
// semi: true
const count = 1;

// semi: false
const count = 1
```

`false` 仍可能保留避免 JavaScript 自動分號插入問題所需的分號。Pug 中的 JavaScript 敘述可用 `pugSemi` 另行設定。[來源：Prettier 選項][prettier-options]

## 三、Pug 基本排版與程式碼格式

這一組的繼承規則如下。`null` 在這裡表示「繼承」，不是關閉功能；`pugPrintWidth` 與 `pugTabWidth` 則使用 `-1` 表示繼承。[來源：實際合併邏輯][pug-converge]

| Pug 選項 | 預設值 | 繼承的共用選項 | 共用選項亦未設定時的效果 |
| --- | --- | --- | --- |
| `pugPrintWidth` | `-1` | `printWidth` | `80` |
| `pugTabWidth` | `-1` | `tabWidth` | `2` |
| `pugUseTabs` | `null` | `useTabs` | `false` |
| `pugSingleQuote` | `null` | `singleQuote` | `false` |
| `pugSemi` | `null` | `semi` | `true` |
| `pugBracketSpacing` | `null` | `bracketSpacing` | `true` |
| `pugBracketSameLine` | `null` | `bracketSameLine` | `false` |
| `pugArrowParens` | `null` | `arrowParens` | `"always"` |

共用選項的預設值依據 [Prettier 官方選項][prettier-options]；Pug 覆寫選項依據 [common.ts][pug-common]。五個布林覆寫選項另外接受字串 `"true"` 作為命令列相容處理；在 JSON 設定中直接使用真正的布林值 `true`／`false` 即可。

### 6. `pugPrintWidth`

- **用途：** 只為 Pug 指定換行參考寬度。
- **可設定值：** 整數；`-1` 表示繼承。
- **預設：** `-1`。

```json
{
  "printWidth": 80,
  "pugPrintWidth": 120
}
```

這表示其他適用的內容以 80 為參考，Pug 以 120 為參考。屬性仍可能因數量門檻或正規表示式規則而提早展開。[來源：選項定義][pug-common]、[屬性換行設定][pug-wrap]

### 7. `pugTabWidth`

- **用途：** 指定 Pug 每層縮排的空格數。
- **可設定值：** 整數；一般填 `2` 或 `4`，`-1` 表示繼承。
- **預設：** `-1`。

當 `pugUseTabs` 為 `false`，且設定 `pugTabWidth: 2`：

```pug
main
  section
    h1 報價管理
```

改成 `pugTabWidth: 4`，每層改用四個空格。[來源：選項定義][pug-common]

### 8. `pugUseTabs`

- **用途：** 選擇 Pug 使用 Tab 或空格縮排。
- **可設定值：** `true`、`false`、`null`。
- **預設：** `null`，繼承 `useTabs`。

| 值 | 行為 |
| --- | --- |
| `true` | 以 Tab 字元縮排 |
| `false` | 以空格縮排，空格數由 `pugTabWidth` 決定 |
| `null` | 沿用共用的 `useTabs` |

例如 `"pugUseTabs": false` 搭配 `"pugTabWidth": 2`，就是兩個空格縮排。[來源：選項定義][pug-common]

### 9. `pugSingleQuote`

- **用途：** 設定 Pug 屬性等適用位置的引號偏好。
- **可設定值：** `true`、`false`、`null`。
- **預設：** `null`，繼承 `singleQuote`。

```pug
//- pugSingleQuote: false
input(type="text", name="email")

//- pugSingleQuote: true
input(type='text', name='email')
```

Vue 屬性若在外層引號中包含 JavaScript 字串，內層通常使用另一種引號，例如：

```pug
//- pugFramework: "vue"，pugSingleQuote: false
button(:title="$t('save')")

//- pugFramework: "vue"，pugSingleQuote: true
button(:title='$t("save")')
```

Vue 的 `{{ ... }}` 文字插值在目前實作中使用共用的 `singleQuote`，因此可能與屬性內 JavaScript 的引號偏好不同。[來源：Pug 覆寫說明][pug-overrides]、[引號測試][pug-quotes-test]、[插值實作][pug-printer]

### 10. `pugSemi`

- **用途：** 控制 Pug 內 JavaScript 敘述的結尾分號。
- **可設定值：** `true`、`false`、`null`。
- **預設：** `null`，繼承 `semi`。

```pug
//- pugSemi: true
- const count = 1;
p= count

//- pugSemi: false
- const count = 1
p= count
```

它會影響 `- const count = 1` 這類敘述；`p= count` 這類輸出運算式不會因此加上結尾分號，也不會在一般標籤行後補分號。[來源：選項定義][pug-common]、[code 輸出實作][pug-printer]

### 11. `pugBracketSpacing`

- **用途：** 控制 JavaScript 物件字面值的大括號內側空格。
- **可設定值：** `true`、`false`、`null`。
- **預設：** `null`，繼承 `bracketSpacing`。

以下是物件片段的差異：

```js
// true
{ count: 1 }

// false
{count: 1}
```

此項不負責設定 Pug 屬性括號內的空格，例如是否把 `input(type="text")` 改成 `input( type="text" )`。[來源：Pug 覆寫說明][pug-overrides]

### 12. `pugBracketSameLine`

- **用途：** 控制多行屬性右括號 `)` 的位置。
- **可設定值：** `true`、`false`、`null`。
- **預設：** `null`，繼承 `bracketSameLine`；共用預設為 `false`。

下例假設屬性已因其他設定而展開。

```pug
//- false：右括號獨立一行
input(
  type="email",
  name="email"
)

//- true：右括號接在最後一個屬性後方
input(
  type="email",
  name="email")
```

它只決定右括號位置；若要主動展開屬性，應使用行寬、`pugWrapAttributesThreshold` 或 `pugWrapAttributesPattern`。[來源：選項定義][pug-common]

### 13. `pugArrowParens`

- **用途：** 決定單一參數的箭頭函式是否保留括號。
- **可選值，預設在 `[0]`：** `[null, "always", "avoid"]`。
- **預設：** `null`，繼承 `arrowParens`。

以下是 JavaScript 函式片段的差異：

```js
// "always"
(item) => item.id

// "avoid"
item => item.id
```

`"avoid"` 只在語法允許時省略括號；多個參數、解構參數等仍需要括號。[來源：選項定義][pug-common]、[Prettier 選項][prettier-options]

## 四、屬性分隔、換行與括號

### 14. `pugAttributeSeparator`

- **用途：** 決定屬性之間何時使用逗號。
- **可選值，預設在 `[0]`：** `["always", "as-needed", "none"]`。
- **預設：** `"always"`。

| 值 | 行為 |
| --- | --- |
| `"always"` | 屬性之間使用逗號 |
| `"as-needed"` | 只有語法需要時才使用逗號 |
| `"none"` | 不使用逗號 |

```pug
//- "always"
input(type="text", name="email", required)

//- "none"
input(type="text" name="email" required)
```

Angular 的 `(click)` 等語法可能需要分隔逗號，因此使用 `"none"` 時須留意可解析性；`"as-needed"` 的輸出不一定等同於 `"none"`。[來源：選項定義][pug-separator]

### 15. `pugWrapAttributesThreshold`

- **用途：** 依屬性數量決定何時強制展開。
- **可設定值：** `-1`、`0`、正整數。
- **預設：** `-1`。

| 值 | 行為 |
| --- | --- |
| `-1` | 不用屬性數量強制換行，仍可因行寬或 pattern 規則換行 |
| `0` | 有屬性的標籤就展開 |
| `1` | 超過一個屬性時展開 |
| `3` | 超過三個屬性，也就是四個以上時展開 |

例如設定為 `1`：

```pug
input(type="text")
input(
  type="text",
  name="email"
)
```

門檻表示「超過這個數量」，不是「達到這個數量」。它也不能用來保證標籤永遠維持單行。[來源：選項定義][pug-wrap]、[官方換行說明][pug-specific]

### 16. `pugWrapAttributesPattern`

- **用途：** 屬性名稱符合正規表示式時，強制展開該標籤的整個屬性區塊。
- **可設定值：** 正規表示式內容的字串。
- **預設：** `""`，不啟用此條件。

```json
{
  "pugWrapAttributesPattern": "^v-if$"
}
```

例如 Vue Pug 模板中的：

```pug
section(v-if="visible", title="Details")
```

會展開為：

```pug
section(
  v-if="visible",
  title="Details"
)
```

這裡比對的是屬性名稱。填 `"^v-if$"` 即可，不要額外包成 `"/^v-if$/"`。它是自由輸入的規則字串，沒有固定的可選值清單。[來源：選項定義][pug-wrap]、[官方 pattern 測試][pug-wrap-test]

### 17. `pugPreserveAttributeBrackets`

- **用途：** 決定原有的空屬性括號 `()` 是否保留。
- **可設定值：** `true`、`false`。
- **預設：** `false`。

原始內容：

```pug
button.primary()&attributes(attrs)
```

不同結果：

```pug
//- false
button.primary&attributes(attrs)

//- true
button.primary()&attributes(attrs)
```

`true` 是保留已有的空括號，不是替每個沒有屬性的標籤自動補上 `()`。[來源：選項定義][pug-preserve-brackets]、[官方說明][pug-specific]

### 18. `pugClosingBracketIndentDepth`

- **用途：** 設定獨立一行的右括號要與標籤或屬性對齊。
- **可設定值：** `0`、`1`。
- **預設：** `0`。
- **生效條件：** 有效的 `pugBracketSameLine` 為 `false`。

```pug
//- 0：與標籤對齊
input(
  type="email",
  name="email"
)

//- 1：與屬性對齊
input(
  type="email",
  name="email"
  )
```

它不控制子元素的縮排，只控制這個右括號的位置。[來源：選項定義][pug-closing-depth]

## 五、屬性排序

### 19. `pugSortAttributes`

- **用途：** 設定屬性的基本排序方式。
- **可選值，預設在 `[0]`：** `["as-is", "asc", "desc"]`。
- **預設：** `"as-is"`。

同一組屬性的結果：

```pug
//- "as-is"：維持原順序
Widget(b, a, c)

//- "asc"：升冪
Widget(a, b, c)

//- "desc"：降冪
Widget(c, b, a)
```

若也設定 Beginning／End 規則，前置、後置群組的位置會先受到規則控制；其餘屬性再依本項設定排序。此選項不會排序 `class="..."` 裡面的 class 名稱。[來源：排序選項][pug-sort]、[排序實作][pug-sort-utils]

### 20. `pugSortAttributesBeginning`

- **用途：** 指定要放到前面的屬性及群組順序。
- **可設定值：** 正規表示式字串陣列。
- **預設：** `[]`，沒有前置規則。

```json
{
  "pugSortAttributes": "as-is",
  "pugSortAttributesBeginning": ["^type$", "^name$"]
}
```

```pug
//- 格式化前
input(readonly, name="email", type="email")

//- 格式化後
input(type="email", name="email", readonly)
```

這裡的陣列是真正的設定值，所有規則都會使用；不是從中選一個。`^type$` 表示完整名稱是 `type`，避免只寫 `type` 時也匹配其他包含這段文字的名稱。[來源：排序選項][pug-sort]、[排序實作][pug-sort-utils]

### 21. `pugSortAttributesEnd`

- **用途：** 將符合規則的屬性放到後面。
- **可設定值：** 正規表示式字串陣列。
- **預設：** `[]`，沒有後置規則。

```json
{
  "pugSortAttributes": "as-is",
  "pugSortAttributesBeginning": ["^type$", "^name$"],
  "pugSortAttributesEnd": ["^disabled$"]
}
```

```pug
//- 格式化前
input(readonly, disabled, name="email", type="email")

//- 格式化後
input(type="email", name="email", readonly, disabled)
```

設定時盡量避免同一屬性同時命中多個前置、後置規則，讓排序結果容易預期。[來源：排序選項][pug-sort]、[排序實作][pug-sort-utils]

## 六、Class、ID 與 div

### 22. `pugClassNotation`

- **用途：** 決定 class 使用 Pug 簡寫或一般屬性寫法。
- **可選值，預設在 `[0]`：** `["literal", "attribute", "as-is"]`。
- **預設：** `"literal"`。

```pug
//- "literal"
button.primary.large

//- "attribute"
button(class="primary large")

//- "as-is"：保留原本混用的表示方式
button.primary(class="large")
```

`"literal"` 只轉換能以 Pug 簡寫安全表示的靜態 class。動態內容，例如 `button(class=classes)`，不能直接變成固定的 `.class`。`"as-is"` 只保留 class 的表示方式，其他縮排、引號或逗號仍可被格式化。[來源：選項定義][pug-class-notation]、[格式輸出實作][pug-printer]

### 23. `pugIdNotation`

- **用途：** 決定 ID 是否轉成 `#id` 簡寫。
- **可選值，預設在 `[0]`：** `["literal", "as-is"]`。
- **預設：** `"literal"`。

輸入為 `input(id="email")` 時：

```pug
//- "literal"
input#email

//- "as-is"
input(id="email")
```

**目前沒有可用的 `"attribute"` 值。** 如果原本是 `input#email`，設為 `"as-is"` 也不會主動改成 `input(id="email")`。[來源：現行選項定義][pug-id-notation]、[官方未實作註記][pug-specific]

### 24. `pugClassLocation`

- **用途：** 決定 `.class` 簡寫放在屬性括號之前或之後。
- **可選值，預設在 `[0]`：** `["before-attributes", "after-attributes"]`。
- **預設：** `"before-attributes"`。

```pug
//- "before-attributes"
button.primary(type="button")

//- "after-attributes"
button(type="button").primary
```

它控制的是 `.primary` 這類簡寫的位置；若要排序 `class="primary"` 這種一般屬性，應使用屬性排序選項。[來源：選項定義][pug-class-location]

### 25. `pugExplicitDiv`

- **用途：** 決定有 class 或 ID 簡寫的 `div` 是否必須明確寫出。
- **可設定值：** `true`、`false`。
- **預設：** `false`。

```pug
//- false
.card

//- true
div.card
```

此項控制 `div` 的省略，不會將 `section`、`button` 等標籤改成 `div`。[來源：選項定義][pug-explicit-div]

## 七、空屬性

### 26. `pugEmptyAttributes`

- **用途：** 統一無值或空字串屬性的寫法。
- **可選值，預設在 `[0]`：** `["as-is", "none", "all"]`。
- **預設：** `"as-is"`。

同一份輸入 `input(disabled, readonly="")` 的結果如下：

```pug
//- "as-is"：保留原本的空值表示方式
input(disabled, readonly="")

//- "none"：移除空引號
input(disabled, readonly)

//- "all"：補上空引號
input(disabled="", readonly="")
```

此項是調整空值表示方式，不代表會刪掉整個屬性，也不是把屬性設為 `false`。轉換依據是語法中的空值，不應將任意非布林屬性的空字串與無值寫法都視為具有相同 HTML 語意。[來源：選項定義][pug-empty]、[空屬性實作][pug-empty-utils]

### 27. `pugEmptyAttributesForceQuotes`

- **用途：** 指定哪些空屬性必須保留或補上空引號。
- **可設定值：** 正規表示式字串陣列。
- **預設：** `[]`。

例如讓名為 `foo` 的空屬性一定有引號：

```json
{
  "pugEmptyAttributes": "none",
  "pugEmptyAttributesForceQuotes": ["^foo$"]
}
```

```pug
//- 格式化前
input(disabled="", foo)

//- 格式化後
input(disabled, foo="")
```

即使整體設定為 `"none"`，符合規則的空屬性仍會有引號。已有非空值的屬性不會因此被清空；本項也不只在 `"none"` 模式下才有效。[來源：選項定義][pug-empty]、[優先判斷邏輯][pug-empty-utils]

## 八、註解與文字空白

### 28. `pugCommentPreserveSpaces`

- **用途：** 決定註解內容中的多餘空白如何處理。
- **可選值，預設在 `[0]`：** `["keep-all", "keep-leading", "trim-all"]`。
- **預設：** `"keep-all"`。

以下三行對照的是同一段註解文字在不同設定下的結果：

```pug
//-   section   header
//-   section header
//- section header
```

| 對應行 | 設定 | 行為 |
| --- | --- | --- |
| 第一行 | `"keep-all"` | 保留原有空白 |
| 第二行 | `"keep-leading"` | 保留開頭空白，整理後面的重複空白 |
| 第三行 | `"trim-all"` | 整理開頭及內容中的多餘空白 |

`"trim-all"` 不會把註解文字中的單字全部黏在一起；它整理的是多餘空白。[來源：選項與處理函式][pug-comment-spaces]

### 29. `pugPreserveWhitespace`

- **用途：** 保留文字內容中的額外空白。
- **可設定值：** `true`、`false`。
- **預設：** `true`。

例如原始內容在 `|` 後有兩個空格：

```pug
p
  |  hello
```

當設為 `false`，額外空白可能被移除：

```pug
p
  | hello
```

設為 `true` 時，外掛會保留該空白的意義，必要時改用額外的 `|` 行表示。**保留文字空白，不等於原始檔的每一行、縮排及排版都保持不變。** [來源：選項定義][pug-preserve-whitespace]、[官方說明][pug-specific]

## 九、框架與單檔元件

### 30. `pugFramework`

- **用途：** 指定外掛要依哪個框架處理模板語法。
- **可選值，預設在 `[0]`：** `["auto", "vue", "svelte", "angular"]`。
- **預設：** `"auto"`。

| 值 | 用途 |
| --- | --- |
| `"auto"` | 嘗試從專案執行環境資訊偵測框架；未偵測到時使用一般策略 |
| `"vue"` | 使用 Vue 模板的處理方式；Vue／Nuxt 專案可明確選這個值 |
| `"svelte"` | 選擇 Svelte；官方文件目前說明其行為與 Vue 相同 |
| `"angular"` | 使用 Angular 對應的插值處理方式 |

```json
{
  "pugFramework": "vue"
}
```

這項設定控制格式化時的語法處理，不會替專案安裝框架或把模板轉成另一種框架。[來源：選項定義][pug-framework]、[官方框架說明][pug-specific]

### 31. `pugSingleFileComponentIndentation`

- **用途：** 決定單檔元件的 `<template lang="pug">` 內容是否額外縮排一層。
- **可設定值：** `true`、`false`。
- **預設：** `false`。

```vue
<!-- false -->
<template lang="pug">
main
  h1 報價管理
</template>
```

```vue
<!-- true -->
<template lang="pug">
  main
    h1 報價管理
</template>
```

此項用於嵌入單檔元件的 Pug，不會替一般獨立 `.pug` 檔案的全部內容加一層縮排。[來源：選項定義][pug-sfc]、[生效條件][pug-converge]

## 十、常用需求對照

| 想調整的效果 | 主要設定 |
| --- | --- |
| Pug 用雙引號，JavaScript 用單引號 | `singleQuote: true`、`pugSingleQuote: false` |
| 兩個空格縮排 | `pugUseTabs: false`、`pugTabWidth: 2` |
| 超過三個屬性就展開 | `pugWrapAttributesThreshold: 3` |
| 有任何屬性就展開 | `pugWrapAttributesThreshold: 0` |
| 不依屬性數量強制展開 | `pugWrapAttributesThreshold: -1`；行寬與 pattern 仍可能造成換行 |
| 遇到 `v-if` 就展開 | `pugWrapAttributesPattern: "^v-if$"` |
| 右括號單獨一行，與標籤對齊 | `pugBracketSameLine: false`、`pugClosingBracketIndentDepth: 0` |
| class 統一寫在屬性內 | `pugClassNotation: "attribute"` |
| class 與 ID 保留原本表示方式 | `pugClassNotation: "as-is"`、`pugIdNotation: "as-is"` |
| 明確寫出 `div` | `pugExplicitDiv: true` |
| Vue／Nuxt 明確指定框架 | `pugFramework: "vue"` |

此表是前面選項的使用組合，並非額外選項；詳細規則與來源見各項說明。

## 十一、使用時容易混淆的地方

1. **選項清單與正式設定不同。** `pugClassNotation` 等列舉欄位要選一個值；`plugins`、排序規則及 ForceQuotes 本來就是陣列，應保留。
2. **`null` 代表繼承，不是 `false`。** 例如 `pugSemi: null` 會採用共用的 `semi`。
3. **不同選項的 `-1` 意義不同。** `pugPrintWidth`／`pugTabWidth` 是繼承；`pugWrapAttributesThreshold` 是停用依數量強制換行。
4. **`as-is` 只針對該選項保留原樣。** 例如 class 表示方式不變，整行仍會受到其他格式設定影響。
5. **正規表示式以字串提供。** 使用 `"^type$"` 這種寫法；若 JSON 字串需要反斜線，應依 JSON 規則跳脫。
6. **部分選項有版本門檻。** `pugClosingBracketIndentDepth` 於外掛 3.1.0 新增，`pugPreserveWhitespace` 於 3.3.0 新增。遇到不認得的設定時，可先檢查安裝版本。[來源：官方變更紀錄][pug-changelog]

## 十二、可直接使用的正式 .prettierrc

這份保留先前範例的主要選擇：行寬 100、兩格縮排、JavaScript 單引號、Pug 雙引號、屬性間有逗號、超過三個屬性展開。其餘補齊的 Pug 選項採預設或繼承值。

```json
{
  "plugins": ["@prettier/plugin-pug"],

  "printWidth": 100,
  "tabWidth": 2,
  "singleQuote": true,
  "semi": false,

  "pugPrintWidth": 100,
  "pugTabWidth": 2,
  "pugUseTabs": false,
  "pugSingleQuote": false,
  "pugSemi": null,
  "pugBracketSpacing": null,
  "pugBracketSameLine": false,
  "pugArrowParens": null,

  "pugAttributeSeparator": "always",
  "pugWrapAttributesThreshold": 3,
  "pugWrapAttributesPattern": "",
  "pugPreserveAttributeBrackets": false,
  "pugClosingBracketIndentDepth": 0,

  "pugSortAttributes": "as-is",
  "pugSortAttributesBeginning": [],
  "pugSortAttributesEnd": [],

  "pugClassNotation": "literal",
  "pugIdNotation": "literal",
  "pugClassLocation": "before-attributes",
  "pugExplicitDiv": false,

  "pugEmptyAttributes": "as-is",
  "pugEmptyAttributesForceQuotes": [],

  "pugCommentPreserveSpaces": "keep-all",
  "pugPreserveWhitespace": true,

  "pugFramework": "auto",
  "pugSingleFileComponentIndentation": false
}
```

用於 Vue／Nuxt 時，可將 `"pugFramework": "auto"` 改為 `"pugFramework": "vue"`。若希望 `<template lang="pug">` 內的內容額外縮排，再把 `pugSingleFileComponentIndentation` 改為 `true`。

需要安裝套件時：

```bash
pnpm add -D prettier @prettier/plugin-pug
```

將上面正式設定存成專案根目錄的 `.prettierrc` 後，可格式化 Pug 檔案：

```bash
pnpm exec prettier --write "**/*.pug"
```

`--write` 會寫回符合條件的檔案。外掛安裝與載入方式依據 [官方使用指南][pug-guide]。

## 官方參考資料

- [Prettier 通用選項][prettier-options]
- [Pug 外掛使用指南][pug-guide]
- [Pug 對 Prettier 選項的覆寫][pug-overrides]
- [Pug 專屬選項文件][pug-specific]
- [Pug 公開選項匯出清單][pug-index]
- [Pug 通用覆寫選項原始碼][pug-common]
- [Pug 選項繼承與合併邏輯][pug-converge]
- [Pug 外掛變更紀錄][pug-changelog]

[prettier-options]: https://prettier.io/docs/options
[pug-guide]: https://prettier.github.io/plugin-pug/guide/
[pug-overrides]: https://prettier.github.io/plugin-pug/guide/standard-prettier-overrides.html
[pug-specific]: https://prettier.github.io/plugin-pug/guide/pug-specific-options.html
[pug-index]: https://github.com/prettier/plugin-pug/blob/main/src/options/index.ts
[pug-common]: https://github.com/prettier/plugin-pug/blob/main/src/options/common.ts
[pug-converge]: https://github.com/prettier/plugin-pug/blob/main/src/options/converge.ts
[pug-separator]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-attribute-separator.ts
[pug-wrap]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-wrap-attributes.ts
[pug-preserve-brackets]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-preserve-attribute-brackets.ts
[pug-closing-depth]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-closing-bracket-indent-depth.ts
[pug-sort]: https://github.com/prettier/plugin-pug/blob/main/src/options/attribute-sorting/index.ts
[pug-sort-utils]: https://github.com/prettier/plugin-pug/blob/main/src/options/attribute-sorting/utils.ts
[pug-class-notation]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-class-notation.ts
[pug-id-notation]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-id-notation.ts
[pug-class-location]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-class-location.ts
[pug-explicit-div]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-explicit-div.ts
[pug-empty]: https://github.com/prettier/plugin-pug/blob/main/src/options/empty-attributes/index.ts
[pug-empty-utils]: https://github.com/prettier/plugin-pug/blob/main/src/options/empty-attributes/utils.ts
[pug-comment-spaces]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-comment-preserve-spaces.ts
[pug-preserve-whitespace]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-preserve-whitespace.ts
[pug-framework]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-framework.ts
[pug-sfc]: https://github.com/prettier/plugin-pug/blob/main/src/options/pug-single-file-component-indentation.ts
[pug-printer]: https://github.com/prettier/plugin-pug/blob/main/src/printer.ts
[pug-quotes-test]: https://github.com/prettier/plugin-pug/blob/main/tests/options/singleQuote/single-false-pug-true/formatted.pug
[pug-wrap-test]: https://github.com/prettier/plugin-pug/blob/main/tests/options/pugWrapAttributesPattern/wrap-attributes-pattern.test.ts
[pug-changelog]: https://github.com/prettier/plugin-pug/blob/main/CHANGELOG.md
