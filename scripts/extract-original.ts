import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import iconv from "iconv-lite";

const rootDir = resolve(import.meta.dirname, "..");
const dataDatPath = join(rootDir, "output", "PSP_GAME", "USRDIR", "DATA.DAT");
const paramSfoPath = join(rootDir, "output", "PSP_GAME", "PARAM.SFO");
const ebootPath = join(rootDir, "output", "PSP_GAME", "SYSDIR", "EBOOT.BIN");
const bootPath = join(rootDir, "output", "PSP_GAME", "SYSDIR", "BOOT.BIN");
const umdDataPath = join(rootDir, "output", "UMD_DATA.BIN");
const outPath = join(rootDir, "workspace", "original.csv");

const nispackMagic = Buffer.from("NISPACK\x00", "ascii");
const nispackHeaderSize = 16;
const nispackEntrySize = 44;
const keywordEntrySize = 28;

const textOpcodeHints = new Set([0x050e, 0x051e, 0x0579, 0x07dd]);
const nonTextOpcodes = new Set([0x0193, 0x089c, 0x0967]);
const textFieldPrefixBytesByOpcode = new Map([[0x07dd, 1]]);
const punct = new Set("、。，．・：；？！「」『』（）［］【】＜＞…ー―─-");

type Status = "confirmed" | "candidate";
type Confidence = "high" | "medium" | "low";
type EncodingName = "shift_jis" | "cp932" | "utf-8" | "ascii";
type TransformName = "none" | "xor_ff";

type NispackEntry = {
  index: number;
  name: string;
  entryOffset: number;
  relativeOffset: number;
  absoluteOffset: number;
  size: number;
  flags: number;
  payload: Buffer;
};

type TextMetrics = {
  kana: number;
  cjk: number;
  fullwidth: number;
  latin: number;
  digits: number;
  punct: number;
  replacement: number;
  control: number;
};

type OriginalRow = {
  id: string;
  status: Status;
  confidence: Confidence;
  source_type: string;
  container: string;
  member: string;
  file_path: string;
  record_index: string;
  field_index: string;
  record_key_hex: string;
  region_kind: string;
  opcode_hex: string;
  opcode_text_hint: string;
  encoding: string;
  transform: TransformName;
  member_offset_hex: string;
  member_offset: string;
  data_dat_offset_hex: string;
  data_dat_offset: string;
  raw_length: string;
  decoded_length: string;
  kana: string;
  cjk: string;
  fullwidth: string;
  latin: string;
  digits: string;
  punct: string;
  replacement: string;
  control: string;
  source: string;
  translation: string;
  note: string;
  meta_json: string;
};

const fieldnames: (keyof OriginalRow)[] = [
  "id",
  "status",
  "confidence",
  "source_type",
  "container",
  "member",
  "file_path",
  "record_index",
  "field_index",
  "record_key_hex",
  "region_kind",
  "opcode_hex",
  "opcode_text_hint",
  "encoding",
  "transform",
  "member_offset_hex",
  "member_offset",
  "data_dat_offset_hex",
  "data_dat_offset",
  "raw_length",
  "decoded_length",
  "kana",
  "cjk",
  "fullwidth",
  "latin",
  "digits",
  "punct",
  "replacement",
  "control",
  "source",
  "translation",
  "note",
  "meta_json",
];

function hex(value: number) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function hex4(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function readUInt32LE(data: Buffer, offset: number) {
  if (offset < 0 || offset + 4 > data.length) {
    throw new Error(`UInt32 越界：offset=${hex(offset)}, size=${data.length}`);
  }
  return data.readUInt32LE(offset);
}

function readUInt16LE(data: Buffer, offset: number) {
  if (offset < 0 || offset + 2 > data.length) {
    throw new Error(`UInt16 越界：offset=${hex(offset)}, size=${data.length}`);
  }
  return data.readUInt16LE(offset);
}

function decodeLegacy(raw: Buffer, encoding: EncodingName) {
  if (encoding === "ascii") {
    return raw.toString("ascii");
  }
  if (encoding === "utf-8") {
    return raw.toString("utf8");
  }
  return iconv.decode(raw, encoding);
}

function encodeLegacy(text: string, encoding: EncodingName) {
  if (encoding === "ascii") {
    return Buffer.from(text, "ascii");
  }
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf8");
  }
  return iconv.encode(text, encoding);
}

function roundtripDecode(
  raw: Buffer,
  encoding: EncodingName,
  options: { allowCp932Extensions?: boolean; canonicalizeWaveDash?: boolean } = {},
) {
  try {
    let text = decodeLegacy(raw, encoding);
    if (text.includes("\ufffd") || (!options.allowCp932Extensions && hasCp932OnlyText(text))) {
      return null;
    }
    const encoded = encodeLegacy(text, encoding);
    if (!encoded.equals(raw)) {
      return null;
    }
    if (options.canonicalizeWaveDash) {
      text = text.replaceAll("～", "〜").replaceAll("－", "−");
    }
    return text;
  } catch {
    return null;
  }
}

function decodeText(
  raw: Buffer,
  encoding: EncodingName,
  transform: TransformName,
  options: { allowCp932Extensions?: boolean; canonicalizeWaveDash?: boolean } = {},
) {
  const bytes = transform === "xor_ff" ? xorBuffer(raw) : raw;
  return roundtripDecode(bytes, encoding, options);
}

function xorBuffer(raw: Buffer) {
  const decoded = Buffer.allocUnsafe(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    decoded[i] = raw[i]! ^ 0xff;
  }
  return decoded;
}

function encodeXorText(text: string, encoding: EncodingName) {
  return xorBuffer(encodeLegacy(text, encoding));
}

function hasCp932OnlyText(text: string) {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x2460 && code <= 0x24ff) ||
      (code >= 0x3200 && code <= 0x33ff) ||
      (code >= 0x2160 && code <= 0x217f) ||
      (code >= 0xe000 && code <= 0xf8ff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      code === 0x2116 ||
      code === 0x2121 ||
      code === 0xffe2
    ) {
      return true;
    }
  }
  return false;
}

function scoreText(text: string): TextMetrics {
  const metrics: TextMetrics = {
    kana: 0,
    cjk: 0,
    fullwidth: 0,
    latin: 0,
    digits: 0,
    punct: 0,
    replacement: 0,
    control: 0,
  };

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x3040 && code <= 0x30ff) {
      metrics.kana += 1;
    } else if (code >= 0x4e00 && code <= 0x9fff) {
      metrics.cjk += 1;
    } else if (code >= 0xff01 && code <= 0xff60) {
      metrics.fullwidth += 1;
    } else if (/^[A-Za-z]$/.test(ch)) {
      metrics.latin += 1;
    } else if (/^\d$/.test(ch)) {
      metrics.digits += 1;
    } else if (punct.has(ch)) {
      metrics.punct += 1;
    } else if (ch === "\ufffd") {
      metrics.replacement += 1;
    } else if (code < 0x20) {
      metrics.control += 1;
    }
  }

  return metrics;
}

function stripAsciiEdges(text: string) {
  return text.replace(/^[\x00\r\n\t ]+|[\x00\r\n\t ]+$/g, "");
}

function storyProbableText(text: string, metrics: TextMetrics, minChars = 2) {
  const stripped = stripAsciiEdges(text);
  if (stripped.length < minChars) {
    return false;
  }
  if (metrics.replacement) {
    return false;
  }
  const jpish = metrics.kana + metrics.cjk + metrics.fullwidth;
  if (jpish >= 1) {
    return true;
  }
  if (metrics.punct && stripped.length >= 3) {
    return true;
  }
  return /[【＜「『]/.test(stripped);
}

function genericProbableText(text: string, metrics: TextMetrics, minChars = 2) {
  const stripped = text.trim();
  if (stripped.length < minChars) {
    return false;
  }
  if (metrics.replacement || metrics.control) {
    return false;
  }
  const jpish = metrics.kana + metrics.cjk + metrics.fullwidth;
  return jpish >= 1 || (metrics.punct >= 1 && stripped.length >= 3);
}

function candidateProbableText(text: string, metrics: TextMetrics) {
  const stripped = stripAsciiEdges(text);
  if (stripped.length < 3 || metrics.replacement || metrics.control) {
    return false;
  }
  const jpish = metrics.kana + metrics.cjk + metrics.fullwidth;
  if (jpish >= 2) {
    return true;
  }
  if (metrics.kana >= 1 && stripped.length >= 4) {
    return true;
  }
  if (metrics.latin >= 4 && metrics.punct + metrics.digits >= 1) {
    return true;
  }
  return false;
}

function halfwidthCount(text: string) {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xff61 && code <= 0xff9f) {
      count += 1;
    }
  }
  return count;
}

function cleanLeadingPrefix(raw: Buffer, text: string, encoding: EncodingName) {
  let bestDelta = 0;
  let bestRaw = raw;
  let bestText = text;
  let bestHalfwidth = halfwidthCount(text);
  let bestMetrics = scoreText(text);
  let bestJpish = bestMetrics.kana + bestMetrics.cjk + bestMetrics.fullwidth;

  for (let delta = 1; delta < Math.min(4, raw.length); delta += 1) {
    const candidateRaw = raw.subarray(delta);
    const candidateText = decodeText(candidateRaw, encoding, "xor_ff", { canonicalizeWaveDash: true });
    if (candidateText === null) {
      continue;
    }
    const candidateMetrics = scoreText(candidateText);
    if (candidateMetrics.replacement || candidateMetrics.control) {
      continue;
    }
    const candidateJpish = candidateMetrics.kana + candidateMetrics.cjk + candidateMetrics.fullwidth;
    const candidateHalfwidth = halfwidthCount(candidateText);
    if (candidateHalfwidth < bestHalfwidth && candidateJpish >= bestJpish - 1) {
      bestDelta = delta;
      bestRaw = candidateRaw;
      bestText = candidateText;
      bestHalfwidth = candidateHalfwidth;
      bestMetrics = candidateMetrics;
      bestJpish = candidateJpish;
    }
  }

  return { delta: bestDelta, raw: bestRaw, text: bestText };
}

function trimControlEdges(raw: Buffer, text: string, encoding: EncodingName) {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) < 0x20) {
    start += 1;
  }
  while (end > start && text.charCodeAt(end - 1) < 0x20) {
    end -= 1;
  }
  if (start === 0 && end === text.length) {
    return { delta: 0, raw, text };
  }

  const trimmed = text.slice(start, end);
  const encoded = encodeXorText(trimmed, encoding);
  const delta = raw.indexOf(encoded);
  return { delta: delta < 0 ? 0 : delta, raw: encoded, text: trimmed };
}

function csvEscape(value: string) {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function writeCsv(rows: OriginalRow[]) {
  mkdirSync(dirname(outPath), { recursive: true });
  const lines = [
    fieldnames.join(","),
    ...rows.map((row) => fieldnames.map((field) => csvEscape(row[field])).join(",")),
  ];
  writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
}

function makeRow(input: {
  id: string;
  status: Status;
  confidence: Confidence;
  sourceType: string;
  container: string;
  member: string;
  filePath?: string | undefined;
  recordIndex?: number | string;
  fieldIndex?: number | string;
  recordKeyHex?: string;
  regionKind?: string;
  opcodeHex?: string;
  opcodeTextHint?: string;
  encoding: string;
  transform: TransformName;
  memberOffset?: number;
  dataDatOffset?: number | undefined;
  rawLength?: number;
  source: string;
  note?: string;
  meta?: Record<string, unknown>;
}): OriginalRow {
  const metrics = scoreText(input.source);
  return {
    id: input.id,
    status: input.status,
    confidence: input.confidence,
    source_type: input.sourceType,
    container: input.container,
    member: input.member,
    file_path: input.filePath ?? "",
    record_index: input.recordIndex === undefined ? "" : String(input.recordIndex),
    field_index: input.fieldIndex === undefined ? "" : String(input.fieldIndex),
    record_key_hex: input.recordKeyHex ?? "",
    region_kind: input.regionKind ?? "",
    opcode_hex: input.opcodeHex ?? "",
    opcode_text_hint: input.opcodeTextHint ?? "",
    encoding: input.encoding,
    transform: input.transform,
    member_offset_hex: input.memberOffset === undefined ? "" : hex(input.memberOffset),
    member_offset: input.memberOffset === undefined ? "" : String(input.memberOffset),
    data_dat_offset_hex: input.dataDatOffset === undefined ? "" : hex(input.dataDatOffset),
    data_dat_offset: input.dataDatOffset === undefined ? "" : String(input.dataDatOffset),
    raw_length: input.rawLength === undefined ? "" : String(input.rawLength),
    decoded_length: String(input.source.length),
    kana: String(metrics.kana),
    cjk: String(metrics.cjk),
    fullwidth: String(metrics.fullwidth),
    latin: String(metrics.latin),
    digits: String(metrics.digits),
    punct: String(metrics.punct),
    replacement: String(metrics.replacement),
    control: String(metrics.control),
    source: input.source,
    translation: "",
    note: input.note ?? "",
    meta_json: input.meta === undefined ? "" : JSON.stringify(input.meta),
  };
}

function parseNispack(data: Buffer): NispackEntry[] {
  const base = data.indexOf(nispackMagic);
  if (base < 0) {
    throw new Error("DATA.DAT 中找不到 NISPACK 头");
  }

  const count = readUInt32LE(data, base + 12);
  const entries: NispackEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = base + nispackHeaderSize + index * nispackEntrySize;
    const rawName = data.subarray(entryOffset, entryOffset + 32);
    const nul = rawName.indexOf(0);
    const name = rawName.subarray(0, nul < 0 ? rawName.length : nul).toString("ascii");
    const relativeOffset = readUInt32LE(data, entryOffset + 32);
    const size = readUInt32LE(data, entryOffset + 36);
    const flags = readUInt32LE(data, entryOffset + 40);
    const absoluteOffset = base + relativeOffset;
    if (absoluteOffset + size > data.length) {
      throw new Error(`NISPACK 成员越界：${name}, offset=${hex(absoluteOffset)}, size=${size}`);
    }
    entries.push({
      index,
      name,
      entryOffset,
      relativeOffset,
      absoluteOffset,
      size,
      flags,
      payload: data.subarray(absoluteOffset, absoluteOffset + size),
    });
  }

  return entries;
}

function requireMember(entries: NispackEntry[], name: string) {
  const entry = entries.find((item) => item.name === name);
  if (!entry) {
    throw new Error(`NISPACK 中找不到成员：${name}`);
  }
  return entry;
}

function extractKeywordRows(entry: NispackEntry): OriginalRow[] {
  const data = entry.payload;
  const count = readUInt32LE(data, 0);
  const tableEnd = 4 + count * keywordEntrySize;
  if (tableEnd > data.length) {
    throw new Error(`keyword.dat 表越界：count=${count}, tableEnd=${hex(tableEnd)}, size=${hex(data.length)}`);
  }

  const rows: OriginalRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 4 + index * keywordEntrySize;
    const fields = Array.from({ length: 7 }, (_, field) => readUInt32LE(data, entryOffset + field * 4));
    const sourceOffset = fields[1]!;
    let source = "";
    let rawLength = 0;
    let note = "";
    if (sourceOffset <= 0 || sourceOffset >= data.length) {
      note = "invalid_offset";
    } else {
      let end = data.indexOf(0, sourceOffset);
      if (end < 0) {
        end = data.length;
      }
      const raw = data.subarray(sourceOffset, end);
      rawLength = raw.length;
      const decoded = roundtripDecode(raw, "shift_jis", { canonicalizeWaveDash: true });
      if (decoded === null) {
        note = "decode_error";
      } else {
        source = decoded;
      }
    }

    rows.push(
      makeRow({
        id: `keyword.dat:${index}`,
        status: "confirmed",
        confidence: "high",
        sourceType: "keyword",
        container: "DATA.DAT/NISPACK",
        member: "keyword.dat",
        recordIndex: index,
        fieldIndex: 0,
        encoding: "shift_jis",
        transform: "none",
        memberOffset: sourceOffset,
        dataDatOffset: entry.absoluteOffset + sourceOffset,
        rawLength,
        source,
        note,
        meta: {
          entry_offset_hex: hex(entryOffset),
          meta_hex: hex(fields[0]!),
          field2_hex: hex(fields[2]!),
          field3_hex: hex(fields[3]!),
          field4_hex: hex(fields[4]!),
          field5_hex: hex(fields[5]!),
          field6_hex: hex(fields[6]!),
        },
      }),
    );
  }
  return rows;
}

function* iterStoryRecords(data: Buffer) {
  const bodyStart = readUInt32LE(data, 0);
  const recordCount = readUInt32LE(data, 4);
  const tableEnd = 8 + recordCount * 8;
  if (bodyStart !== tableEnd) {
    throw new Error(`story.dat 表结构异常：bodyStart=${hex(bodyStart)}, tableEnd=${hex(tableEnd)}`);
  }
  for (let index = 0; index < recordCount; index += 1) {
    const key = readUInt32LE(data, 8 + index * 8);
    const offset = readUInt32LE(data, 8 + index * 8 + 4);
    const nextOffset = index === recordCount - 1 ? data.length : readUInt32LE(data, 8 + (index + 1) * 8 + 4);
    yield { index, key, offset, record: data.subarray(offset, nextOffset) };
  }
}

function* iterStorySegments(record: Buffer) {
  let pos = 0;
  let outsideStart = 0;
  while (pos < record.length) {
    if (pos + 4 <= record.length && record[pos] === 0xff) {
      const length = record[pos + 1]!;
      if (length >= 4 && pos + length <= record.length) {
        if (outsideStart < pos) {
          yield {
            regionKind: "outside",
            opcode: null,
            regionOffset: outsideStart,
            region: record.subarray(outsideStart, pos),
          };
        }
        const opcode = readUInt16LE(record, pos + 2);
        yield {
          regionKind: "command_payload",
          opcode,
          regionOffset: pos + 4,
          region: record.subarray(pos + 4, pos + length),
        };
        pos += length;
        outsideStart = pos;
        continue;
      }
    }
    pos += 1;
  }
  if (outsideStart < record.length) {
    yield {
      regionKind: "outside",
      opcode: null,
      regionOffset: outsideStart,
      region: record.subarray(outsideStart),
    };
  }
}

function* iterRuns(
  data: Buffer,
  minRaw: number,
  boundaryBytes: Set<number>,
  encoding: EncodingName,
  transform: TransformName,
  options: { allowCp932Extensions?: boolean; canonicalizeWaveDash?: boolean } = {},
) {
  let start: number | null = null;
  for (let pos = 0; pos <= data.length; pos += 1) {
    const boundary = pos === data.length || boundaryBytes.has(data[pos]!);
    if (boundary) {
      if (start !== null && pos - start >= minRaw) {
        const raw = data.subarray(start, pos);
        const text = decodeText(raw, encoding, transform, options);
        if (text !== null) {
          yield { offset: start, raw, text };
        }
      }
      start = null;
    } else if (start === null) {
      start = pos;
    }
  }
}

function extractStoryRows(entry: NispackEntry): OriginalRow[] {
  const rows: OriginalRow[] = [];
  for (const { index, key, offset: recordOffset, record } of iterStoryRecords(entry.payload)) {
    let fieldIndex = 0;
    for (const segment of iterStorySegments(record)) {
      if (segment.opcode !== null && nonTextOpcodes.has(segment.opcode)) {
        continue;
      }
      for (const run of iterRuns(segment.region, 4, new Set([0x00]), "shift_jis", "xor_ff", {
        canonicalizeWaveDash: true,
      })) {
        let payloadOffset = run.offset;
        let raw = run.raw;
        let text = run.text;
        const fieldPrefix = segment.opcode === null ? 0 : (textFieldPrefixBytesByOpcode.get(segment.opcode) ?? 0);
        if (fieldPrefix && raw.length > fieldPrefix) {
          const prefixedText = decodeText(raw.subarray(fieldPrefix), "shift_jis", "xor_ff", {
            canonicalizeWaveDash: true,
          });
          if (prefixedText !== null) {
            payloadOffset += fieldPrefix;
            raw = raw.subarray(fieldPrefix);
            text = prefixedText;
          }
        }
        const trimmed = trimControlEdges(raw, text, "shift_jis");
        payloadOffset += trimmed.delta;
        raw = trimmed.raw;
        text = trimmed.text;
        const metrics = scoreText(text);
        if (!storyProbableText(text, metrics)) {
          continue;
        }
        const memberOffset = recordOffset + segment.regionOffset + payloadOffset;
        rows.push(
          makeRow({
            id: `story.dat:${index}:${fieldIndex}:${hex(memberOffset)}`,
            status: "confirmed",
            confidence: "high",
            sourceType: "story",
            container: "DATA.DAT/NISPACK",
            member: "story.dat",
            recordIndex: index,
            fieldIndex,
            recordKeyHex: hex(key),
            regionKind: segment.regionKind,
            opcodeHex: segment.opcode === null ? "" : hex4(segment.opcode),
            opcodeTextHint: segment.opcode !== null && textOpcodeHints.has(segment.opcode) ? "yes" : "",
            encoding: "shift_jis",
            transform: "xor_ff",
            memberOffset,
            dataDatOffset: entry.absoluteOffset + memberOffset,
            rawLength: raw.length,
            source: text,
            meta: {
              record_offset_hex: hex(recordOffset),
              region_offset_hex: hex(recordOffset + segment.regionOffset),
              region_length: segment.region.length,
            },
          }),
        );
        fieldIndex += 1;
      }
    }
  }
  return rows;
}

function extractXorRows(entry: NispackEntry, sourceType: string): OriginalRow[] {
  const rows: OriginalRow[] = [];
  let fieldIndex = 0;
  for (const run of iterRuns(entry.payload, 4, new Set([0x00, 0xff]), "shift_jis", "xor_ff", {
    canonicalizeWaveDash: true,
  })) {
    let offset = run.offset;
    let raw = run.raw;
    let text = stripAsciiEdges(run.text);
    const cleaned = cleanLeadingPrefix(raw, text, "shift_jis");
    offset += cleaned.delta;
    raw = cleaned.raw;
    text = stripAsciiEdges(cleaned.text);
    const metrics = scoreText(text);
    if (!genericProbableText(text, metrics)) {
      continue;
    }
    rows.push(
      makeRow({
        id: `${entry.name}:${fieldIndex}:${hex(offset)}`,
        status: "confirmed",
        confidence: "high",
        sourceType,
        container: "DATA.DAT/NISPACK",
        member: entry.name,
        fieldIndex,
        encoding: "shift_jis",
        transform: "xor_ff",
        memberOffset: offset,
        dataDatOffset: entry.absoluteOffset + offset,
        rawLength: raw.length,
        source: text,
      }),
    );
    fieldIndex += 1;
  }
  return rows;
}

function parseParamSfoTitle(): OriginalRow[] {
  if (!existsSync(paramSfoPath)) {
    return [];
  }
  const data = readFileSync(paramSfoPath);
  if (data.subarray(0, 4).compare(Buffer.from([0x00, 0x50, 0x53, 0x46])) !== 0) {
    throw new Error("PARAM.SFO 不是 PSF 文件");
  }
  const version = readUInt32LE(data, 4);
  if (version !== 0x101) {
    throw new Error(`不支持的 PARAM.SFO 版本：${hex(version)}`);
  }
  const keyTableOffset = readUInt32LE(data, 8);
  const dataTableOffset = readUInt32LE(data, 12);
  const entryCount = readUInt32LE(data, 16);

  for (let index = 0; index < entryCount; index += 1) {
    const entryOffset = 20 + index * 16;
    const keyOffset = readUInt16LE(data, entryOffset);
    const format = readUInt16LE(data, entryOffset + 2);
    const size = readUInt32LE(data, entryOffset + 4);
    const maxSize = readUInt32LE(data, entryOffset + 8);
    const valueOffset = readUInt32LE(data, entryOffset + 12);
    const keyStart = keyTableOffset + keyOffset;
    const keyEnd = data.indexOf(0, keyStart);
    if (keyEnd < 0) {
      throw new Error(`PARAM.SFO key 未终止：entry=${index}`);
    }
    const key = data.subarray(keyStart, keyEnd).toString("ascii");
    if (key !== "TITLE") {
      continue;
    }
    if (format !== 0x0204) {
      throw new Error(`PARAM.SFO TITLE 格式异常：${hex(format)}`);
    }
    const absoluteOffset = dataTableOffset + valueOffset;
    const raw = data.subarray(absoluteOffset, absoluteOffset + size);
    const nul = raw.indexOf(0);
    const source = raw.subarray(0, nul < 0 ? raw.length : nul).toString("utf8");
    return [
      makeRow({
        id: "PARAM.SFO:TITLE",
        status: "confirmed",
        confidence: "high",
        sourceType: "param_sfo",
        container: "PSP_GAME",
        member: "PSP_GAME/PARAM.SFO",
        filePath: paramSfoPath,
        recordIndex: key,
        fieldIndex: 0,
        encoding: "utf-8",
        transform: "none",
        memberOffset: absoluteOffset,
        rawLength: raw.length,
        source,
        meta: {
          key,
          entry_offset_hex: hex(entryOffset),
          max_size: maxSize,
        },
      }),
    ];
  }

  throw new Error("PARAM.SFO 中找不到 TITLE");
}

function rowKey(row: OriginalRow) {
  return [row.member, row.encoding, row.transform, row.member_offset_hex, row.raw_length, row.source].join("\u0000");
}

function buildConfirmedCoverage(rows: OriginalRow[]) {
  const exact = new Set<string>();
  const rangesByMember = new Map<string, Array<{ start: number; end: number }>>();
  for (const row of rows) {
    exact.add(rowKey(row));
    const start = Number(row.member_offset);
    const length = Number(row.raw_length);
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) {
      continue;
    }
    const ranges = rangesByMember.get(row.member) ?? [];
    ranges.push({ start, end: start + length });
    rangesByMember.set(row.member, ranges);
  }
  return { exact, rangesByMember };
}

function overlapsConfirmed(member: string, offset: number, length: number, rangesByMember: Map<string, Array<{ start: number; end: number }>>) {
  const ranges = rangesByMember.get(member);
  if (!ranges) {
    return false;
  }
  const end = offset + length;
  return ranges.some((range) => offset < range.end && end > range.start);
}

function scanCandidateRuns(input: {
  data: Buffer;
  container: string;
  member: string;
  filePath?: string;
  baseDataDatOffset?: number;
  exact: Set<string>;
  rangesByMember: Map<string, Array<{ start: number; end: number }>>;
}) {
  const rows: OriginalRow[] = [];
  const seen = new Set<string>();
  const profiles: Array<{
    encoding: EncodingName;
    transform: TransformName;
    boundaries: Set<number>;
    minRaw: number;
    sourceType: string;
  }> = [
    { encoding: "shift_jis", transform: "none", boundaries: new Set([0x00]), minRaw: 4, sourceType: "candidate_plain_sjis" },
    { encoding: "shift_jis", transform: "xor_ff", boundaries: new Set([0x00, 0xff]), minRaw: 4, sourceType: "candidate_xor_sjis" },
    { encoding: "cp932", transform: "none", boundaries: new Set([0x00]), minRaw: 4, sourceType: "candidate_plain_cp932" },
    { encoding: "cp932", transform: "xor_ff", boundaries: new Set([0x00, 0xff]), minRaw: 4, sourceType: "candidate_xor_cp932" },
    { encoding: "ascii", transform: "none", boundaries: new Set([0x00]), minRaw: 5, sourceType: "candidate_ascii" },
    { encoding: "utf-8", transform: "none", boundaries: new Set([0x00]), minRaw: 6, sourceType: "candidate_utf8" },
  ];

  for (const profile of profiles) {
    let localIndex = 0;
    for (const run of iterRuns(input.data, profile.minRaw, profile.boundaries, profile.encoding, profile.transform, {
      allowCp932Extensions: profile.encoding === "cp932",
      canonicalizeWaveDash: profile.encoding === "shift_jis",
    })) {
      const source = stripAsciiEdges(run.text);
      const metrics = scoreText(source);
      if (!candidateProbableText(source, metrics)) {
        continue;
      }
      if (overlapsConfirmed(input.member, run.offset, run.raw.length, input.rangesByMember)) {
        continue;
      }

      const rowInput = {
        id: `${profile.sourceType}:${input.member}:${localIndex}:${hex(run.offset)}`,
        status: "candidate",
        confidence: profile.encoding === "cp932" ? "medium" : "low",
        sourceType: profile.sourceType,
        container: input.container,
        member: input.member,
        fieldIndex: localIndex,
        encoding: profile.encoding,
        transform: profile.transform,
        memberOffset: run.offset,
        dataDatOffset: input.baseDataDatOffset === undefined ? undefined : input.baseDataDatOffset + run.offset,
        rawLength: run.raw.length,
        source,
        note: "candidate_scan",
      } satisfies Parameters<typeof makeRow>[0];
      const row = makeRow(input.filePath === undefined ? rowInput : { ...rowInput, filePath: input.filePath });
      if (input.exact.has(rowKey(row))) {
        continue;
      }
      const key = [row.member, row.member_offset_hex, row.transform, row.source].join("\u0000");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(row);
      localIndex += 1;
    }
  }
  return rows;
}

function scanOuterFileCandidates(path: string, member: string, coverage: ReturnType<typeof buildConfirmedCoverage>) {
  if (!existsSync(path)) {
    return [];
  }
  return scanCandidateRuns({
    data: readFileSync(path),
    container: "PSP_GAME",
    member,
    filePath: path,
    exact: coverage.exact,
    rangesByMember: coverage.rangesByMember,
  });
}

function main() {
  if (!existsSync(dataDatPath)) {
    throw new Error(`找不到 DATA.DAT：${dataDatPath}，请先运行 npm run unpack`);
  }

  const dataDat = readFileSync(dataDatPath);
  const entries = parseNispack(dataDat);
  const confirmedRows: OriginalRow[] = [];
  confirmedRows.push(...parseParamSfoTitle());
  confirmedRows.push(...extractKeywordRows(requireMember(entries, "keyword.dat")));
  confirmedRows.push(...extractStoryRows(requireMember(entries, "story.dat")));
  confirmedRows.push(...extractXorRows(requireMember(entries, "logic.dat"), "logic"));
  confirmedRows.push(...extractXorRows(requireMember(entries, "OccultFile.dat"), "occult"));
  confirmedRows.push(...extractXorRows(requireMember(entries, "Selecter.dat"), "selecter"));

  const coverage = buildConfirmedCoverage(confirmedRows);
  const candidateRows: OriginalRow[] = [];
  for (const entry of entries) {
    candidateRows.push(
      ...scanCandidateRuns({
        data: entry.payload,
        container: "DATA.DAT/NISPACK",
        member: entry.name,
        baseDataDatOffset: entry.absoluteOffset,
        exact: coverage.exact,
        rangesByMember: coverage.rangesByMember,
      }),
    );
  }
  candidateRows.push(...scanOuterFileCandidates(ebootPath, "PSP_GAME/SYSDIR/EBOOT.BIN", coverage));
  candidateRows.push(...scanOuterFileCandidates(bootPath, "PSP_GAME/SYSDIR/BOOT.BIN", coverage));
  candidateRows.push(...scanOuterFileCandidates(umdDataPath, "UMD_DATA.BIN", coverage));

  const rows = [...confirmedRows, ...candidateRows];
  writeCsv(rows);

  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    const key = `${row.status}:${row.source_type}`;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`已写入 ${outPath}`);
  console.log(`总行数：${rows.length}`);
  for (const [sourceType, count] of Object.entries(counts)) {
    console.log(`${sourceType}：${count}`);
  }
}

main();
