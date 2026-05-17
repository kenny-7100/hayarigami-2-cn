import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import iconv from "iconv-lite";
import { preferredCharReplacements } from "./game-char-replacements.js";

const rootDir = resolve(import.meta.dirname, "..");
const outputDir = join(rootDir, "output");
const originalCsvPath = join(rootDir, "workspace", "original.csv");
const translatedCsvPath = join(rootDir, "workspace", "translated.csv");
const dataDatPath = join(outputDir, "PSP_GAME", "USRDIR", "DATA.DAT");
const nispackMagic = Buffer.from("NISPACK\x00", "ascii");
const nispackHeaderSize = 16;
const nispackEntrySize = 44;

const requiredColumns = [
  "id",
  "status",
  "container",
  "member",
  "encoding",
  "transform",
  "member_offset",
  "data_dat_offset",
  "raw_length",
  "translation",
] as const;

type RequiredColumn = (typeof requiredColumns)[number];
type EncodingName = "shift_jis" | "cp932" | "utf-8" | "ascii";
type TransformName = "none" | "xor_ff";
type CsvRow = Record<string, string>;
type GameCharset = {
  table: Buffer;
};
type ConfirmedSourceChars = Set<string>;
type CharProblem = {
  char: string;
  suggestion: string | null;
};

function readUInt32LE(data: Buffer, offset: number) {
  if (offset < 0 || offset + 4 > data.length) {
    throw new Error(`UInt32 越界：offset=0x${offset.toString(16)}, size=${data.length}`);
  }
  return data.readUInt32LE(offset);
}

function loadGameCharset(): GameCharset {
  if (!existsSync(dataDatPath)) {
    throw new Error(`找不到 DATA.DAT，无法读取游戏字符集：${dataDatPath}`);
  }

  const data = readFileSync(dataDatPath);
  const base = data.indexOf(nispackMagic);
  if (base < 0) {
    throw new Error("DATA.DAT 中找不到 NISPACK 头，无法读取游戏字符集");
  }

  const count = readUInt32LE(data, base + 12);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = base + nispackHeaderSize + index * nispackEntrySize;
    const rawName = data.subarray(entryOffset, entryOffset + 32);
    const nul = rawName.indexOf(0);
    const name = rawName.subarray(0, nul < 0 ? rawName.length : nul).toString("ascii");
    const relativeOffset = readUInt32LE(data, entryOffset + 32);
    const size = readUInt32LE(data, entryOffset + 36);
    const absoluteOffset = base + relativeOffset;

    if (name !== "jis2ucs.bin") {
      continue;
    }
    if (size !== 65536 * 2) {
      throw new Error(`jis2ucs.bin 大小异常：${size}`);
    }
    if (absoluteOffset + size > data.length) {
      throw new Error(`jis2ucs.bin 越界：offset=0x${absoluteOffset.toString(16)}, size=${size}`);
    }
    return { table: data.subarray(absoluteOffset, absoluteOffset + size) };
  }

  throw new Error("DATA.DAT/NISPACK 中找不到 jis2ucs.bin，无法读取游戏字符集");
}

function parseCsvLine(line: string) {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\"" && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (quoted) {
    throw new Error(`CSV 引号未闭合：${line.slice(0, 120)}`);
  }

  fields.push(current);
  return fields;
}

function parseCsv(content: string) {
  const lines = content.trimEnd().split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }

  const header = parseCsvLine(lines[0]!);
  const missing = requiredColumns.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`translated.csv 缺少列：${missing.join(", ")}`);
  }

  return lines.slice(1).map((line, lineIndex) => {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) {
      throw new Error(`CSV 第 ${lineIndex + 2} 行列数不匹配：${fields.length} != ${header.length}`);
    }

    const row: CsvRow = {};
    header.forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    return row;
  });
}

function loadConfirmedSourceChars(): ConfirmedSourceChars {
  if (!existsSync(originalCsvPath)) {
    throw new Error(`找不到原文表，无法读取 confirmed 显示样本：${originalCsvPath}`);
  }

  const rows = parseCsv(readFileSync(originalCsvPath, "utf8"));
  const chars = new Set<string>();
  for (const row of rows) {
    if (row.status !== "confirmed") {
      continue;
    }
    for (const char of row.source ?? "") {
      chars.add(char);
    }
  }
  return chars;
}

function getRequired(row: CsvRow, column: RequiredColumn) {
  const value = row[column];
  if (value === undefined) {
    throw new Error(`行 ${row.id ?? "(unknown)"} 缺少列：${column}`);
  }
  return value;
}

function parsePositiveInteger(row: CsvRow, column: RequiredColumn) {
  const value = getRequired(row, column);
  if (!/^\d+$/.test(value)) {
    throw new Error(`行 ${row.id} 的 ${column} 不是非负整数：${value}`);
  }
  return Number(value);
}

function parseEncoding(row: CsvRow): EncodingName {
  const value = getRequired(row, "encoding");
  if (value === "shift_jis" || value === "cp932" || value === "utf-8" || value === "ascii") {
    return value;
  }
  throw new Error(`行 ${row.id} 使用了不支持的 encoding：${value}`);
}

function parseTransform(row: CsvRow): TransformName {
  const value = getRequired(row, "transform");
  if (value === "none" || value === "xor_ff") {
    return value;
  }
  throw new Error(`行 ${row.id} 使用了不支持的 transform：${value}`);
}

function encodeText(text: string, encoding: EncodingName) {
  if (encoding === "ascii") {
    return Buffer.from(text, "ascii");
  }
  if (encoding === "utf-8") {
    return Buffer.from(text, "utf8");
  }
  return iconv.encode(text, encoding);
}

function decodeText(data: Buffer, encoding: EncodingName) {
  if (encoding === "ascii") {
    return data.toString("ascii");
  }
  if (encoding === "utf-8") {
    return data.toString("utf8");
  }
  return iconv.decode(data, encoding);
}

function xorBuffer(data: Buffer) {
  const output = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    output[index] = data[index]! ^ 0xff;
  }
  return output;
}

function sjisBytesToJisCode(bytes: Buffer) {
  if (bytes.length === 1) {
    return bytes[0]!;
  }

  if (bytes.length !== 2) {
    return null;
  }

  const lead = bytes[0]!;
  const trail = bytes[1]!;
  if (!((lead >= 0x81 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xfc))) {
    return null;
  }
  if (!((trail >= 0x40 && trail <= 0x7e) || (trail >= 0x80 && trail <= 0xfc))) {
    return null;
  }

  let row = lead < 0xe0 ? (lead - 0x81) * 2 + 0x21 : (lead - 0xe0) * 2 + 0x5f;
  let cell: number;
  if (trail < 0x9f) {
    cell = trail - (trail > 0x7e ? 0x20 : 0x1f);
  } else {
    row += 1;
    cell = trail - 0x7e;
  }

  if (row < 0 || row > 0xff || cell < 0 || cell > 0xff) {
    return null;
  }
  return (row << 8) | cell;
}

function readGameCharsetCodePoint(charset: GameCharset, jisCode: number) {
  if (jisCode < 0 || jisCode >= 65536) {
    return 0;
  }
  return charset.table.readUInt16LE(jisCode * 2);
}

function describeChar(char: string) {
  const codePoint = char.codePointAt(0) ?? 0;
  return `${char}(U+${codePoint.toString(16).toUpperCase().padStart(4, "0")})`;
}

function isInGameCharset(char: string, encoding: EncodingName, charset: GameCharset) {
  const codePoint = char.codePointAt(0) ?? 0;
  const encoded = encodeText(char, encoding);
  const jisCode = sjisBytesToJisCode(encoded);
  const mapped = jisCode === null ? 0 : readGameCharsetCodePoint(charset, jisCode);
  return mapped === codePoint;
}

function normalizeCandidate(char: string) {
  const normalized = char.normalize("NFKC");
  return Array.from(normalized).length === 1 ? normalized : null;
}

function getReplacementCandidates(char: string) {
  const candidates: string[] = [];
  const preferred = preferredCharReplacements.get(char);
  const normalized = normalizeCandidate(char);
  if (preferred !== undefined) {
    candidates.push(preferred);
  }
  if (normalized !== null) {
    candidates.push(normalized);
  }
  return Array.from(new Set(candidates.filter((candidate) => candidate !== char)));
}

function suggestConfirmedChar(char: string, encoding: EncodingName, charset: GameCharset, confirmedSourceChars: ConfirmedSourceChars) {
  for (const candidate of getReplacementCandidates(char)) {
    if (confirmedSourceChars.has(candidate) && isInGameCharset(candidate, encoding, charset)) {
      return candidate;
    }
  }
  return null;
}

function formatCharProblems(items: CharProblem[]) {
  const unique = new Map<string, CharProblem>();
  for (const item of items) {
    unique.set(item.char, item);
  }
  return Array.from(unique.values())
    .map((item) => {
      const base = describeChar(item.char);
      return item.suggestion === null ? base : `${base}，建议改为：${item.suggestion}`;
    })
    .join("、");
}

function assertGameCharset(
  row: CsvRow,
  text: string,
  encoding: EncodingName,
  charset: GameCharset,
  confirmedSourceChars: ConfirmedSourceChars,
) {
  if (encoding === "utf-8") {
    return;
  }

  const unsupported: CharProblem[] = [];
  const unconfirmed: CharProblem[] = [];
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const suggestion = suggestConfirmedChar(char, encoding, charset, confirmedSourceChars);
    const inGameCharset = isInGameCharset(char, encoding, charset);
    if (!inGameCharset) {
      unsupported.push({ char, suggestion });
    }
    if (inGameCharset && codePoint > 0x7f && !confirmedSourceChars.has(char)) {
      unconfirmed.push({ char, suggestion });
    }
  }

  if (unsupported.length > 0) {
    throw new Error(`行 ${row.id} 包含不在游戏内置 jis2ucs 字符集的字符：${formatCharProblems(unsupported)}`);
  }
  if (unconfirmed.length > 0) {
    throw new Error(`行 ${row.id} 包含没有 confirmed 原文显示样本的字符：${formatCharProblems(unconfirmed)}`);
  }
}

function encodeTranslation(row: CsvRow, charset: GameCharset, confirmedSourceChars: ConfirmedSourceChars) {
  const translation = getRequired(row, "translation");
  const encoding = parseEncoding(row);
  const transform = parseTransform(row);
  const rawLength = parsePositiveInteger(row, "raw_length");
  const encoded = encodeText(translation, encoding);
  const roundtrip = decodeText(encoded, encoding);

  if (roundtrip !== translation) {
    throw new Error(`行 ${row.id} 的译文不能用 ${encoding} 无损编码：${translation} -> ${roundtrip}`);
  }

  assertGameCharset(row, translation, encoding, charset, confirmedSourceChars);

  const payload = transform === "xor_ff" ? xorBuffer(encoded) : encoded;
  if (payload.length > rawLength) {
    throw new Error(`行 ${row.id} 译文字节数超限：${payload.length} > ${rawLength}`);
  }

  const padded = Buffer.alloc(rawLength, 0);
  payload.copy(padded);
  return { padded, byteLength: payload.length, rawLength };
}

function outputFileForRow(row: CsvRow) {
  const container = getRequired(row, "container");
  const member = getRequired(row, "member");

  if (container === "DATA.DAT/NISPACK") {
    return { filePath: dataDatPath, offset: parsePositiveInteger(row, "data_dat_offset") };
  }

  const normalizedMember = normalize(member);
  if (normalizedMember.startsWith("..") || normalizedMember.includes(`${sep}..${sep}`)) {
    throw new Error(`行 ${row.id} 的 member 路径不安全：${member}`);
  }

  return {
    filePath: join(outputDir, normalizedMember),
    offset: parsePositiveInteger(row, "member_offset"),
  };
}

function applyPatch(
  fileCache: Map<string, Buffer>,
  row: CsvRow,
  charset: GameCharset,
  confirmedSourceChars: ConfirmedSourceChars,
) {
  const { filePath, offset } = outputFileForRow(row);
  const { padded, byteLength, rawLength } = encodeTranslation(row, charset, confirmedSourceChars);

  if (!existsSync(filePath)) {
    throw new Error(`行 ${row.id} 的目标文件不存在：${filePath}`);
  }

  const data = fileCache.get(filePath) ?? readFileSync(filePath);
  if (offset < 0 || offset + rawLength > data.length) {
    throw new Error(`行 ${row.id} 写入越界：offset=${offset}, raw_length=${rawLength}, file_size=${data.length}`);
  }

  padded.copy(data, offset);
  fileCache.set(filePath, data);

  return {
    id: row.id,
    filePath,
    offset,
    byteLength,
    rawLength,
  };
}

function main() {
  if (!existsSync(translatedCsvPath)) {
    throw new Error(`找不到翻译表：${translatedCsvPath}`);
  }

  const rows = parseCsv(readFileSync(translatedCsvPath, "utf8"));
  const charset = loadGameCharset();
  const confirmedSourceChars = loadConfirmedSourceChars();
  const translatedRows = rows.filter((row) => getRequired(row, "translation").length > 0);
  const skipped = translatedRows.filter((row) => getRequired(row, "status") !== "confirmed");
  if (skipped.length > 0) {
    throw new Error(`translated.csv 包含非 confirmed 译文，已拒绝写回：${skipped.map((row) => row.id).join(", ")}`);
  }

  const fileCache = new Map<string, Buffer>();
  const applied = translatedRows.map((row) => applyPatch(fileCache, row, charset, confirmedSourceChars));

  for (const [filePath, data] of fileCache) {
    const originalMode = statSync(filePath).mode;
    if ((originalMode & 0o200) === 0) {
      chmodSync(filePath, originalMode | 0o200);
    }
    try {
      writeFileSync(filePath, data);
    } finally {
      if ((originalMode & 0o200) === 0) {
        chmodSync(filePath, originalMode);
      }
    }
  }

  console.log(`已读取 ${translatedCsvPath}`);
  console.log(`可写回译文：${translatedRows.length}`);
  for (const item of applied) {
    console.log(`${item.id} -> ${item.filePath} @ ${item.offset} (${item.byteLength}/${item.rawLength} bytes)`);
  }
  console.log(`已写入文件数：${fileCache.size}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
