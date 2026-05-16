# Hayarigami 2 CN Handoff

更新时间：2026-05-17

## 当前目标

本仓库用于推进 PSP 版《流行之神 2》的中文化工具链。当前阶段重点是从已解包的游戏镜像中识别文本，并统一输出到一个表格：

```text
workspace/original.csv
```

用户明确希望本项目倾向使用 Node.js / TypeScript 方案，而不是沿用另一个 `lxzs` 项目的 Python 工具链。

## 当前项目结构

关键路径：

```text
game/1.iso                         原始 PSP ISO
output/                            npm run unpack 后的解包目录
output/PSP_GAME/USRDIR/DATA.DAT    游戏主资源包
build/2.iso                        npm run build 生成的新 ISO
workspace/original.csv             当前唯一文本提取输出物
scripts/extract-original.ts        当前 TypeScript 文本提取入口
```

当前 npm 入口：

```sh
npm run unpack
npm run extract-original
npm run build
npm run run1
npm run run2
```

其中 `extract-original` 当前指向：

```sh
tsx scripts/extract-original.ts
```

## 已完成的工作

已经把 `extract-original` 从 `todo` 实现为 Node.js / TypeScript 版本，并加入：

```text
iconv-lite
```

原因：Node 标准库不能可靠地把字符串编码回 Shift-JIS，而后续文本裁剪、长度校验和写回都需要 Shift-JIS encode 能力。

当前脚本会直接解析：

```text
output/PSP_GAME/USRDIR/DATA.DAT
```

内部的 `NISPACK`，并抽取已确认资源：

```text
PARAM.SFO TITLE
keyword.dat
story.dat
logic.dat
OccultFile.dat
Selecter.dat
```

同时还会做候选扫描：

```text
plain shift_jis
xor_ff shift_jis
plain cp932
xor_ff cp932
utf-8
```

最终仍然只写一个文件：

```text
workspace/original.csv
```

## original.csv 设计

`workspace/original.csv` 是单表宽表。核心字段：

```text
id
status
confidence
source_type
container
member
file_path
record_index
field_index
record_key_hex
region_kind
opcode_hex
opcode_text_hint
encoding
transform
member_offset_hex
member_offset
data_dat_offset_hex
data_dat_offset
raw_length
decoded_length
kana
cjk
fullwidth
latin
digits
punct
replacement
control
source
translation
note
meta_json
```

最重要的区分是：

```text
status=confirmed
status=candidate
```

含义：

- `confirmed`：格式和位置较明确，后续可以作为翻译和写回主线。
- `candidate`：扫描器发现的疑似文本，可能是真文本，也可能是资源名、调试字符串、控制数据或误解码结果。不能直接进入写回流程。

后续写回脚本应优先只处理：

```text
status=confirmed
```

## 当前提取结果

最近一次执行：

```sh
npm run extract-original
```

输出总行数：

```text
86450
```

分布如下：

```text
confirmed:param_sfo     1
confirmed:keyword       433
confirmed:story         69584
confirmed:logic         1816
confirmed:occult        4053
confirmed:selecter      20

candidate_plain_sjis    2424
candidate_xor_sjis      3274
candidate_xor_cp932     4725
candidate_plain_cp932   118
candidate_utf8          2
```

按大类：

```text
confirmed 75907 行，约 87.80%
candidate 10543 行，约 12.20%
```

## 与 lxzs 项目的关系

用户要求参考另一个项目：

```text
/Users/kenny/kenny/lxzs
```

该项目也是针对《流行之神 2》PSP 的汉化工作流，已经摸清了大部分非视觉文本来源和提取方式。

当前项目没有直接复制 Python 脚本，而是用 TypeScript 重新实现，并将输出合并成一个 CSV。

旧 `lxzs` 稳定表可作为 confirmed 提取的下限参考。当前 TypeScript 版本相对旧项目：

```text
story    missing_vs_lxzs 0, extra_vs_lxzs 14
logic    missing_vs_lxzs 0, extra_vs_lxzs 14
occult   missing_vs_lxzs 0, extra_vs_lxzs 0
selecter missing_vs_lxzs 0, extra_vs_lxzs 0
```

解释：

- 没有丢掉旧项目已确认的 story / logic / occult / selecter 文本。
- 当前 Node/iconv 方案在 story 和 logic 里各多识别 14 行 confirmed。
- 额外 candidate 行用于扩大文本发现范围，不应直接视作可写回文本。

## 编码和写回约束

`lxzs` 项目的已有回填策略是保守的原地写回：

```text
译文编码后的字节长度 <= 原始 raw_length / length
```

对 `story.dat`、`logic.dat`、`OccultFile.dat`、`Selecter.dat`：

```text
translation -> shift_jis encode -> XOR 0xFF -> 写回原 member_offset
剩余空间补 0x00
```

对 `keyword.dat`：

```text
translation -> shift_jis encode -> 写回原 offset
剩余空间补 0x00
```

对 `PARAM.SFO TITLE`：

```text
translation -> utf-8 encode
len(bytes) + 1 <= max_size
```

旧项目没有做：

```text
扩容 story.dat
移动字符串
重建指针表
扩大 DATA.DAT
改 EBOOT 编码逻辑
任意 UTF-8 中文支持
```

下一步如果先求稳定，应继续采用同长或更短的原地写回策略。

## 已验证命令

当前已通过：

```sh
npm run extract-original
npx tsc --noEmit
git diff --check
```

`npm run extract-original` 会重写：

```text
workspace/original.csv
```

## 下一步建议

### 1. 审计 candidate 文本

优先看：

```text
status=candidate
source_type=candidate_xor_cp932
source_type=candidate_xor_sjis
```

它们是 candidate 的主要来源。

目标不是直接翻译它们，而是判断：

- 是否真实用户可见文本
- 是否来自某个尚未结构化解析的资源
- 是否只是重复字段、资源名、控制数据或误解码

如果确认某类 candidate 有价值，应新增专用 extractor，把它升级成 `status=confirmed`。

### 2. 设计 translated.csv 或复用 original.csv 的 translation 列

当前 `original.csv` 已包含空的：

```text
translation
note
```

可选路线：

- 直接在 `workspace/original.csv` 填 `translation`
- 或生成单独的 `workspace/translated.csv`

如果继续坚持“单一源表”，可以先直接使用 `original.csv` 的 `translation` 列。但写回脚本应只处理：

```text
status=confirmed
translation 非空
```

### 3. 实现 apply/build translation

建议新增：

```text
scripts/apply-translations.ts
```

初版只支持 confirmed 资源：

```text
keyword.dat
story.dat
logic.dat
OccultFile.dat
Selecter.dat
PARAM.SFO
```

基本规则：

```text
encoding=shift_jis + transform=none     直接编码写回
encoding=shift_jis + transform=xor_ff   编码后每字节 XOR 0xFF 写回
encoding=utf-8 + transform=none         用于 PARAM.SFO
```

必须校验：

```text
encoded byte length <= raw_length
offset + raw_length 不越界
candidate 不写回
decode_error 不写回
```

### 4. patch DATA.DAT 成员

当前提取脚本已经知道 NISPACK member 的 `absoluteOffset`，后续写回可以先在内存中修改对应 member，再原地写回 `DATA.DAT`。

保守策略：

```text
不改变任何 member size
不改变 NISPACK 文件表
不改变 DATA.DAT 总大小
```

### 5. 构建和 PPSSPP 验证

完成写回后走：

```sh
npm run build
npm run run2
```

并检查：

```text
build/2.iso 是否生成
PPSSPP 是否能启动
logs/run2.log
logs/run2.ppsspp.log
```

## 注意事项

- 不要把 `candidate` 直接当成可翻译主表。
- 不要为了容纳长中文先改 DATA.DAT 大小；先保持原地写回。
- 简体中文很多字符不能 Shift-JIS 编码，初版翻译要受编码限制。
- `iconv-lite` 的 Shift-JIS / CP932 行为和 Python strict `shift_jis` 不完全一致；这是本项目识别更多文本的原因之一，也是 candidate 分层存在的原因。
- `workspace/original.csv` 很大，后续处理时尽量用脚本过滤，不要手工全量打开编辑。
