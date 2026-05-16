---
name: coverage
description: 在 hayarigami-2-cn 项目中，需要检查 translated.csv 相对 original.csv 的翻译覆盖率、确认未覆盖区间，或判断当前翻译进度时使用。
---

# coverage

只在 `/Users/kenny/hayarigami-2-cn` 项目内使用这个 skill。

## 用途

检查 `workspace/translated.csv` 相对 `workspace/original.csv` 的翻译覆盖率。

统计口径：

- 只统计 `original.csv` 中 `status=confirmed` 的条目
- `translated.csv` 中同 id 且 `translation` 非空，才算覆盖
- `original.csv` 中 `status=candidate` 的条目不进入分母，也不要求覆盖
- `translated.csv` 中存在非空 translation 但 id 不存在于 `original.csv` 时，脚本会失败
- 任一 CSV 中出现重复 id 时，脚本会失败

## 命令

优先使用 quiet 模式，方便 AI 读取结果：

```sh
yarn -s coverage
```

这个脚本不需要参数。不要传 id，也不要传 `all`。

## 输出约定

全覆盖时，脚本输出：

```text
统计范围：original.status=confirmed
全部覆盖：<覆盖数>/<总数>
覆盖率：100.00%
```

未全覆盖时，脚本输出：

```text
统计范围：original.status=confirmed
未覆盖数：<数量>
未覆盖区间数：<数量>
未覆盖区间:
- 开始: <起始 id>
  结束: <结束 id>
  数量: <区间内未覆盖数量>

覆盖未完成：<覆盖数>/<总数>
覆盖率：<百分比>
```

未覆盖区间按 `original.csv` 的行顺序合并。一个区间不是地址范围的数学连续，而是原表行顺序上的连续未覆盖段。

## AI 使用流程

1. 在需要判断翻译进度、批量翻译是否覆盖完整、或写回前做进度检查时，运行 `yarn -s coverage`。
2. 如果输出 `全部覆盖`，可以说明 confirmed 范围内已全部覆盖。
3. 如果输出 `覆盖未完成`，向用户报告 `覆盖未完成`、`覆盖率`、`未覆盖数` 和 `未覆盖区间数`。
4. 如果用户需要继续翻译，优先使用 `未覆盖区间` 的第一段作为下一批处理范围。
5. 不要把 `candidate` 条目算进用户口径里的覆盖缺口。
6. 如果脚本失败并输出重复 id 或未知翻译 id，先修正 CSV 数据一致性，再重新运行覆盖率检查。

## 示例

运行：

```sh
yarn -s coverage
```

未完成输出示例：

```text
统计范围：original.status=confirmed
未覆盖数：75900
未覆盖区间数：2
未覆盖区间:
- 开始: PARAM.SFO:TITLE
  结束: story.dat:2106:13:0x45CC28
  数量: 69168
- 开始: story.dat:2109:7:0x45D3D4
  结束: Selecter.dat:19:0x2F4
  数量: 6732

覆盖未完成：7/75907
覆盖率：0.01%
```

解释这个输出时，应说：`original.csv` 的 confirmed 条目共 75907 个，其中 7 个已有非空翻译，仍有 75900 个未覆盖，未覆盖内容合并成 2 个区间。
