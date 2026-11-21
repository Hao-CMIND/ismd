# pug-lint 設定與規則說明

本文件整理官方 `pugjs/pug-lint` 的 **44 項內建檢查規則**與 **3 個一般設定**，包含各項用途、可設定值、啟用與停用方式，以及 `.pug-lintrc` 設定範例。

查核日期：2026-11-11。依據 `pugjs/pug-lint` 官方專案的規則文件、設定 Schema 與原始碼整理；本次查核的 `package.json` 版本為 `2.7.0`，不代表已檢查你專案安裝的版本。[官方專案][project]、[規則文件][rules]、[設定 Schema][schema]

## 設定方式與預設行為

設定可放在 `.pug-lintrc`、`.pug-lintrc.json`、`.pug-lintrc.js`，或 `package.json` 的 `pugLintConfig` 欄位。[官方設定說明][project]

- **下方表格列的是啟用規則時可填的值。** 所有規則都可以使用 `null` 明確停用。
- **不要用 `false` 當成通用關閉值。** 多數接受 `true` 的規則會驗證值，傳入 `false` 可能造成設定錯誤。
- 沒有繼承設定時，未指定的風格規則不會啟用。
- 使用 `extends` 時，省略某個規則仍會繼承父設定；要關閉繼承的規則，應明確填 `null`。
- 即使沒有啟用風格規則，linter 仍會回報 Pug 解析錯誤。

上述關閉與繼承行為依據 [linter 實作][linter]。

```json
{
  "disallowDuplicateAttributes": true,
  "disallowBlockExpansion": null
}
```

這表示啟用重複屬性檢查，並明確關閉冒號展開語法的限制。

## 一、一般設定：3 項

| 設定名稱 | 用途 | 可設定值／預設 |
| --- | --- | --- |
| `extends` | 繼承其他設定檔或共用設定套件 | 設定檔路徑或套件名稱字串 |
| `excludeFiles` | 排除不檢查的檔案 | glob 字串陣列；預設 `["node_modules/**"]` |
| `additionalRules` | 載入自行撰寫的檢查規則 | 規則檔案的 glob 字串陣列 |

範例：

```json
{
  "extends": "./config/pug-base.json",
  "excludeFiles": [
    "node_modules/**",
    "dist/**"
  ],
  "additionalRules": [
    "lint-rules/*.js"
  ]
}
```

這是示意設定；使用時應將路徑改成專案實際存在的設定檔及規則檔。`excludeFiles`、`additionalRules` 本來就是陣列，陣列中的項目會一起使用。

舊的 `preset` 已棄用，目前使用會造成錯誤，應改用 `extends`；它不計入上述三個一般設定。[官方設定說明][project]、[linter 實作][linter]

## 二、縮排、換行與檔案長度：7 項

| 規則名稱 | 檢查內容 | 啟用時可設定值 |
| --- | --- | --- |
| `validateIndentation` | 縮排是否符合指定的空格數或 Tab | 正整數，例如 `2`、`4`；或 `"\t"` |
| `validateLineBreaks` | 換行字元是否一致 | `"LF"`、`"CRLF"`、`"CR"` |
| `requireLineFeedAtFileEnd` | 檔案結尾必須有換行 | `true` |
| `disallowTrailingSpaces` | 禁止行尾多餘空白 | `true` |
| `disallowMultipleLineBreaks` | 禁止連續多個空白行 | `true` |
| `maximumLineLength` | 限制每行最大長度 | 整數，例如 `120` |
| `maximumNumberOfLines` | 限制單一檔案的總行數 | 整數，例如 `300` |

範例：

```json
{
  "validateIndentation": 2,
  "validateLineBreaks": "LF",
  "requireLineFeedAtFileEnd": true,
  "disallowTrailingSpaces": true,
  "disallowMultipleLineBreaks": true,
  "maximumLineLength": 120,
  "maximumNumberOfLines": 300
}
```

`maximumLineLength` 限制每行長度，`maximumNumberOfLines` 限制整份檔案的行數；超過指定上限時，對應規則會回報錯誤。[規則文件][rules]

## 三、屬性檢查：8 項

| 規則名稱 | 檢查內容 | 啟用時可設定值 |
| --- | --- | --- |
| `disallowDuplicateAttributes` | 禁止重複屬性，也檢查 `#id` 與 `id="..."` 重複；class 除外 | `true` |
| `disallowSpecificAttributes` | 禁止指定屬性，可對所有標籤或特定標籤設定 | 字串、字串／物件陣列 |
| `requireSpecificAttributes` | 指定標籤必須具有某些屬性 | 物件陣列，例如 `[{"img":["alt"]}]` |
| `requireLowerCaseAttributes` | 屬性名稱必須小寫；XML 模式略過 | `true` |
| `validateAttributeQuoteMarks` | 檢查字串屬性值的引號樣式 | `"\""`、`"'"`、`true` |
| `validateAttributeSeparator` | 檢查屬性之間的逗號、空格及換行格式 | 字串或設定物件 |
| `disallowSpacesInsideAttributeBrackets` | 屬性括號內側不能留空格，例如 `input(type="text")` | `true` |
| `requireSpacesInsideAttributeBrackets` | 屬性括號內側必須留空格，例如 `input( type="text" )` | `true` |

來源：[規則文件][rules]、[設定 Schema][schema]。

### 指定必須存在的屬性

```json
{
  "requireSpecificAttributes": [
    {
      "img": ["alt"]
    },
    {
      "button": ["type"]
    }
  ]
}
```

這會檢查 `img` 是否有 `alt`、`button` 是否有 `type`。它檢查屬性存在與否，不會判定 `alt` 描述品質，也不是完整的無障礙驗證。[必要屬性實作][required-attributes]

### 禁止指定屬性

```json
{
  "disallowSpecificAttributes": [
    "style",
    {
      "img": ["title"]
    }
  ]
}
```

這個示例表示禁止所有標籤使用 `style` 屬性，另外禁止 `img` 使用 `title`。這只是展示規則格式，不代表所有專案都應採用這些限制。[規則文件][rules]

### 指定屬性引號

```json
{
  "validateAttributeQuoteMarks": "\""
}
```

上述設定要求受檢查的字串屬性使用雙引號；若要單引號，改成 `"'"`。

`true` 是自動判斷一致性的模式。實務上明確指定引號字元較容易預期結果。這條規則不會要求 `href=url` 這類動態運算式變成引號字串。[引號檢查實作][quote-marks]

### 區分單行與多行屬性分隔

```json
{
  "validateAttributeSeparator": {
    "separator": ", ",
    "multiLineSeparator": ",\n  "
  }
}
```

- `separator`：單行屬性之間的分隔方式；此例是逗號加一個空格。
- `multiLineSeparator`：跨行屬性之間的分隔方式；此例是逗號、換行與兩個空格。

物件模式需要同時提供兩個欄位。若只寫 `", "`，同一分隔要求也會套用到跨行屬性，不能當成允許任意換行的設定。請依模板的屬性分隔方式及縮排，指定需要檢查的字串。[屬性分隔實作][attribute-separator]

## 四、Class、ID 寫法與順序：10 項

這裡的 literal 指的是 Pug 的 `.class`、`#id` 簡寫。

| 規則名稱 | 檢查內容 | 啟用時可設定值 |
| --- | --- | --- |
| `disallowClassAttributeWithStaticValue` | 靜態 `class="box"` 必須改用 `.box` | `true` |
| `disallowClassLiterals` | 禁止 `.box` 簡寫，使用 `class="box"` | `true` |
| `disallowIdAttributeWithStaticValue` | 靜態 `id="main"` 必須改用 `#main` | `true` |
| `disallowIdLiterals` | 禁止 `#main` 簡寫，使用 `id="main"` | `true` |
| `requireClassLiteralsBeforeAttributes` | `.class` 必須在屬性括號前 | `true` |
| `disallowClassLiteralsBeforeAttributes` | `.class` 必須在屬性括號後 | `true` |
| `requireIdLiteralsBeforeAttributes` | `#id` 必須在屬性括號前 | `true` |
| `disallowIdLiteralsBeforeAttributes` | `#id` 必須在屬性括號後 | `true` |
| `requireClassLiteralsBeforeIdLiterals` | `.class` 必須在 `#id` 前，例如 `.box#main` | `true` |
| `disallowClassLiteralsBeforeIdLiterals` | `#id` 必須在 `.class` 前，例如 `#main.box` | `true` |

來源：[規則文件][rules]、[設定 Schema][schema]。

這些規則有互相相反的組合，應依團隊採用的寫法選擇，不能全部開啟。例如要求 class 使用簡寫時，不要同時禁止 class 簡寫：

```json
{
  "disallowClassAttributeWithStaticValue": true,
  "disallowClassLiterals": null
}
```

官方套件沒有 `requireClassLiterals`、`requireIdLiterals` 或 `requireDivTags` 這些選項。靜態 class 改用簡寫的正式規則名稱就是 `disallowClassAttributeWithStaticValue`。[設定 Schema][schema]

## 五、標籤、結構與模板語法：8 項

| 規則名稱 | 檢查內容 | 啟用時可設定值 |
| --- | --- | --- |
| `disallowBlockExpansion` | 禁止 `p: strong 文字` 這類冒號展開寫法 | `true` |
| `disallowHtmlText` | 禁止直接混入 HTML 標記，例如 `<strong>文字</strong>` | `true` |
| `disallowSpecificTags` | 禁止指定標籤 | 字串或字串陣列，例如 `["b", "i"]` |
| `requireLowerCaseTags` | 標籤名稱必須小寫；XML 模式略過 | `true` |
| `validateDivTags` | 檢查可省略的 `div`，例如 `div.box` 應寫成 `.box` | `true` |
| `validateSelfClosingTags` | 禁止 HTML 空元素多餘的 `/`，例如 `link/` 應寫成 `link` | `true` |
| `validateExtensions` | 檢查 `include`／`extends` 副檔名；`extends` 使用 `.pug` | `true` |
| `disallowLegacyMixinCall` | 禁止舊版 mixin 呼叫方式，使用 `+name()` | `true` |

來源：[規則文件][rules]、[設定 Schema][schema]。

三個容易誤讀的地方：

- `validateDivTags` 是要求省略不必要的 `div`，不是要求每次都明確寫出 `div`。
- `validateSelfClosingTags` 不是要求所有標籤自閉合，也不是禁止所有自訂標籤的 `/`；XML 模式會略過此檢查。[自閉合檢查實作][self-closing]
- `validateExtensions` 仍允許 `include file.txt` 這類引入其他格式檔案的寫法。[規則文件][rules]

## 六、JavaScript、插值與字串：11 項

| 規則名稱 | 檢查內容 | 啟用時可設定值 |
| --- | --- | --- |
| `disallowAttributeConcatenation` | 禁止屬性值中的字串串接 | `true`、`"aggressive"` |
| `disallowAttributeInterpolation` | 禁止舊式屬性插值，例如 `href="page/#{id}"` | `true` |
| `disallowAttributeTemplateString` | 限制屬性值中的反引號模板字串 | `true`、`"all"` |
| `disallowStringConcatenation` | 禁止輸出運算式中的字串串接 | `true`、`"aggressive"` |
| `disallowStringInterpolation` | 禁止 Pug 文字插值，例如 `p #{title}` | `true` |
| `disallowTagInterpolation` | 禁止標籤插值，例如 `#[strong 文字]` | `true` |
| `disallowTemplateString` | 限制輸出運算式中的反引號模板字串 | `true`、`"all"` |
| `validateTemplateString` | 檢查不必要的模板字串及模板字串串接 | `true` 或子規則陣列 |
| `requireStrictEqualityOperators` | JavaScript 比較必須使用 `===`、`!==` | `true` |
| `requireSpaceAfterCodeOperator` | Pug 的 `-`、`=`、`!=` 後必須有一個空格 | `true` 或運算子陣列 |
| `disallowSpaceAfterCodeOperator` | Pug 的 `-`、`=`、`!=` 後不能有空格 | `true` 或運算子陣列 |

來源：[規則文件][rules]、[設定 Schema][schema]；`disallowAttributeConcatenation` 的額外值另見下方說明。

### aggressive 的意思

`true` 用來限制字串串接；`"aggressive"` 會進一步限制變數之間的 `+`，因此連數值相加都可能被檢查，不能視為能判斷所有執行時型別。

```pug
//- true 模式會檢查的字串串接
a(href='/page/' + id) 查看

//- aggressive 模式也可能檢查這種相加
a(data-total=first + second) 查看
```

`disallowAttributeConcatenation` 的實作接受 `"aggressive"`，但官方文件標題及 Schema 漏列了這個值；`disallowStringConcatenation` 則有在 Schema 列出。[屬性串接實作][attribute-concatenation]、[設定 Schema][schema]

### all 的意思

`disallowAttributeTemplateString` 與 `disallowTemplateString` 的 `true` 會限制直接使用的模板字串；`"all"` 也包含函式呼叫等運算式裡面的模板字串。

```pug
//- 直接使用
a(href=`/page/${id}`) 查看

//- 包在函式呼叫內，all 模式也會檢查
a(href=makeUrl(`/page/${id}`)) 查看
```

來源：[規則文件][rules]。

### validateTemplateString 的子規則

| 子規則 | 檢查目的 |
| --- | --- |
| `"variable"` | 檢查只是包住單一變數／運算式的多餘模板字串 |
| `"string"` | 檢查沒有插值、可改用一般字串的模板字串 |
| `"concatenation"` | 檢查模板字串再透過 `+` 串接的寫法 |

設定 `true` 會啟用全部子規則，也可以用陣列選擇要啟用的部分：

```json
{
  "validateTemplateString": [
    "variable",
    "string",
    "concatenation"
  ]
}
```

這個陣列是真正的設定值，列出的子規則會一起生效。[模板字串檢查實作][template-string]

### 限定要檢查的程式碼運算子

```json
{
  "requireSpaceAfterCodeOperator": [
    "-",
    "=",
    "!="
  ]
}
```

也可以只填 `["-"]`，只要求 `-` 後方有空格。例如：

```pug
- const title = '報價單'
p= title
```

這裡的 `=`、`!=` 是 Pug 程式碼輸出運算子；`requireStrictEqualityOperators` 處理的是 JavaScript 比較運算式，不能將兩者混為一談。[規則文件][rules]

## 七、規則的檢查範圍與限制

| 設定／情況 | 需要注意的行為 |
| --- | --- |
| `requireLowerCaseTags: true` | 會對 `MyComponent` 等含大寫字母的標籤名稱報錯；`doctype xml` 模式略過 |
| `requireLowerCaseAttributes: true` | 會檢查屬性名稱，例如 `userName` 含有大寫字母；`doctype xml` 模式略過 |
| `requireSpecificAttributes: [{"img":["alt"]}]` | 檢查指定標籤是否明確寫出必要屬性，不會判定屬性值的內容品質 |
| 由 `&attributes(...)` 提供屬性 | 必要屬性規則不會推算執行時的物件是否提供 `alt` |

例如，`img&attributes(imageAttrs)` 即使執行時的 `imageAttrs` 含有 `alt`，也不能直接視為符合上述必要屬性設定；這條規則依模板中的屬性 token 進行檢查。[小寫標籤實作][lower-case-tags]、[規則文件][rules]、[必要屬性實作][required-attributes]

## 八、可選值陣列參考

以下將具有多種固定可選值的規則整理為陣列，**`[0]` 放 `null`，表示明確停用規則**。這是文件用的選項目錄，不是正式 `.pug-lintrc`。

```json
{
  "disallowAttributeConcatenation": [null, true, "aggressive"],
  "disallowAttributeTemplateString": [null, true, "all"],
  "disallowStringConcatenation": [null, true, "aggressive"],
  "disallowTemplateString": [null, true, "all"],
  "validateAttributeQuoteMarks": [null, "\"", "'", true],
  "validateLineBreaks": [null, "LF", "CRLF", "CR"]
}
```

正式設定應選擇單一值，例如：

```json
{
  "disallowStringConcatenation": "aggressive",
  "validateAttributeQuoteMarks": "\"",
  "validateLineBreaks": "LF"
}
```

上述目錄以 `null` 表示未啟用狀態，並不是宣稱所有 Schema 都明列了 `default: null`。`excludeFiles`、`additionalRules`、`requireSpecificAttributes` 等設定本來就是陣列，不應一律取 `[0]`。[設定 Schema][schema]、[linter 實作][linter]

## 九、基本 .pug-lintrc.json 設定範例

以下範例啟用重複屬性、舊式 mixin 呼叫、嚴格相等運算子及圖片必要屬性的檢查：

```json
{
  "excludeFiles": [
    "node_modules/**",
    "dist/**"
  ],

  "disallowDuplicateAttributes": true,
  "disallowLegacyMixinCall": true,
  "requireStrictEqualityOperators": true,

  "requireSpecificAttributes": [
    {
      "img": ["alt"]
    }
  ]
}
```

這份可存成 `.pug-lintrc.json`，再依前面各節加入需要的規則。若以 `&attributes(...)` 動態提供屬性，請先確認第七節說明的檢查限制。

## 官方參考資料

- [pug-lint 專案與設定方式][project]
- [完整規則文件][rules]
- [設定 JSON Schema][schema]
- [規則載入、停用與繼承邏輯][linter]
- [屬性串接 aggressive 的實作][attribute-concatenation]
- [屬性分隔與多行設定][attribute-separator]
- [指定必要屬性的實作][required-attributes]
- [模板字串檢查實作][template-string]

[project]: https://github.com/pugjs/pug-lint
[rules]: https://github.com/pugjs/pug-lint/blob/master/docs/rules.md
[schema]: https://github.com/pugjs/pug-lint/blob/master/schemas/pug-lintrc-schema.json
[linter]: https://github.com/pugjs/pug-lint/blob/master/lib/linter.js
[attribute-concatenation]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/disallow-attribute-concatenation.js
[attribute-separator]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/validate-attribute-separator.js
[required-attributes]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/require-specific-attributes.js
[quote-marks]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/validate-attribute-quote-marks.js
[template-string]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/validate-template-string.js
[self-closing]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/validate-self-closing-tags.js
[lower-case-tags]: https://github.com/pugjs/pug-lint/blob/master/lib/rules/require-lower-case-tags.js
