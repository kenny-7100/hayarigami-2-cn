---
name: check-ids
description: 在 hayarigami-2-cn 项目中，需要校验指定翻译 id 或全量已翻译条目的字节长度、目标编码和基础写回安全性时使用。
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
- 编码后的译文字节长度是否小于等于 `raw_length`
- `raw_length` 是否是非负安全整数

注意：这个脚本不能证明游戏字库一定包含所有字形，也不能证明游戏 UI 一定能正确渲染文本。它只是编码和字节预算的检查，不是完整的画面 QA。

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
