---
name: check-ids
description: 在 hayarigami-2-cn 项目中，需要校验指定翻译 id 或全量已翻译条目的字节长度、目标编码、游戏内置 jis2ucs 字符集和基础写回安全性时使用。
---

# check-ids

只在 `/Users/kenny/hayarigami-2-cn` 项目内使用这个 skill。

## 用途

在把文本写回游戏数据前，校验 `workspace/translated.csv` 里的翻译条目。

脚本会检查：

- 请求的 id 是否存在且只出现一次
- 显式传入 id 时，`translation` 是否非空
- `encoding` 是否受支持：`shift_jis`、`cp932`、`utf-8`、`ascii`
- 译文是否能用目标编码无损编码和解码
- `shift_jis`、`cp932`、`ascii` 译文是否落在当前 ISO 内置 `DATA.DAT/NISPACK/jis2ucs.bin` 字符集内
- 非 ASCII 译文字符是否在 `workspace/original.csv` 的 `confirmed` 原文中出现过，作为当前资源里有显示样本的保守证据
- 对部分已知异体字/繁简字给出 confirmed 可显示替代建议；候选表维护在 `scripts/game-char-replacements.ts`
- 编码后的译文字节长度是否小于等于 `raw_length`
- `raw_length` 是否是非负安全整数

当前字符集标准不是完整 JIS X 0213 Plane 1。脚本会读取游戏资源里的 `jis2ucs.bin`，以这张表的非零映射为准。`utf-8` 行通常用于 `PARAM.SFO` 等不走这套游戏文本渲染链路的资源，所以不做 `jis2ucs.bin` 检查。

替代建议表必须满足：左侧字符按当前规则不可安全显示，右侧字符按当前规则可安全显示，并且右侧是左侧的保守字形/正字替代。修改 `scripts/game-char-replacements.ts` 后必须运行 `yarn -s validate-char-replacements`。

注意：这个脚本能提前拦截不属于游戏内置字符集、或没有 confirmed 原文显示样本的译文，但仍不能证明 FontA/FontB 纹理里每个字形像素都正确，也不能证明游戏 UI 一定能正确排版。它是写回前的保守字符集/编码/字节预算检查，不是完整画面 QA。

## 命令

优先使用 quiet 模式，方便 AI 读取结果：

```sh
yarn -s check-ids story.dat:2109:0:0x45D260 story.dat:2109:1:0x45D278
```

检查 `workspace/translated.csv` 里所有非空翻译：

```sh
yarn -s check-ids all
```

`all` 只有在它是唯一参数时才表示全量检查。如果和其他 id 混用，会被当成普通 id。

## 输出约定

全部通过时，脚本只输出：

```text
全部通过：<通过数>/<总数>
```

存在失败项时，脚本只输出失败项和最后统计：

```text
id: <id>
状态: 未通过
字节: <译文字节数>/<原始字节数>
问题: <问题>

未全部通过：<通过数>/<总数>
```

`未全部通过：<通过数>/<总数>` 里的分子是通过数量，所以 `未全部通过：0/2` 表示两个请求 id 都失败。

通过项会被故意省略。除非明确重做脚本设计，否则不要要求这个脚本输出文件位置、原文或译文。

## AI 使用流程

1. 用用户给出的 id 或上游工具产出的 id 运行 `yarn -s check-ids ...`。
2. 如果要检查一批已写入 `workspace/translated.csv` 的翻译，运行 `yarn -s check-ids all`。
3. 如果失败，按脚本输出原样汇报失败项的 `id`、`字节` 和 `问题`。
4. 修改译文后，重新运行同一条检查命令。
5. 在宣称翻译数据可以写回前，再运行一次 `yarn -s check-ids all`。

## 示例

检查指定 id：

```sh
yarn -s check-ids story.dat:2109:0:0x45D260 story.dat:2109:1:0x45D278
```

成功输出：

```text
全部通过：2/2
```

失败输出形态：

```text
id: story.dat:2109:0:0x45D260
状态: 未通过
字节: 18/16
问题: 译文字节数超限：18 > 16

未全部通过：1/2
```

字符集失败输出形态：

```text
id: story.dat:2109:6:0x45D390
状态: 未通过
字节: 18/42
问题: 字符不在游戏内置 jis2ucs 字符集：閒(U+9592)

未全部通过：1/2
```

显示样本失败输出形态：

```text
id: story.dat:2109:5:0x45D368
状态: 未通过
字节: 22/32
问题: 字符没有 confirmed 原文显示样本：數(U+6578)
```

如果脚本有已知替代字，会在同一行给出建议：

```text
问题: 字符没有 confirmed 原文显示样本：數(U+6578)，建议改为：数

未全部通过：6/7
```
