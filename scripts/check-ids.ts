import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import iconv from "iconv-lite";
import { preferredCharReplacements } from "./game-char-replacements.js";

const rootDir = resolve(import.meta.dirname, "..");
const originalCsvPath = join(rootDir, "workspace", "original.csv");
const translatedCsvPath = join(rootDir, "workspace", "translated.csv");
const dataDatPath = join(rootDir, "output", "PSP_GAME", "USRDIR", "DATA.DAT");

const requiredColumns = ["id", "encoding", "raw_length", "translation"] as const;
const nispackMagic = Buffer.from("NISPACK\x00", "ascii");
const nispackHeaderSize = 16;
const nispackEntrySize = 44;

type RequiredColumn = (typeof requiredColumns)[number];
type EncodingName = "shift_jis" | "cp932" | "utf-8" | "ascii";
type CsvRow = Record<string, string> & { lineNumber: string };

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

    const row: CsvRow = { lineNumber: String(lineIndex + 2) };
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
    throw new Error(`第 ${row.lineNumber} 行缺少列：${column}`);
  }
  return value;
}

function getCell(row: CsvRow, column: RequiredColumn, problems: string[]) {
  const value = row[column];
  if (value === undefined) {
    problems.push(`缺少列：${column}`);
    return "";
  }
  return value;
}

function parseEncoding(row: CsvRow, problems: string[]): EncodingName | null {
  const value = getRequired(row, "encoding");
  if (value === "shift_jis" || value === "cp932" || value === "utf-8" || value === "ascii") {
    return value;
  }
  problems.push(`不支持的 encoding：${value}`);
  return null;
}

function encodeText(text: string, encoding: EncodingName, problems: string[]) {
  if (encoding === "ascii") {
    if (!/^[\x00-\x7f]*$/.test(text)) {
      problems.push("译文不能用 ascii 无损编码");
    }
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
  const encoded = encodeText(char, encoding, []);
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

function checkGameCharset(
  text: string,
  encoding: EncodingName,
  charset: GameCharset,
  confirmedSourceChars: ConfirmedSourceChars,
  problems: string[],
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
    problems.push(`字符不在游戏内置 jis2ucs 字符集：${formatCharProblems(unsupported)}`);
  }
  if (unconfirmed.length > 0) {
    problems.push(`字符没有 confirmed 原文显示样本：${formatCharProblems(unconfirmed)}`);
  }
}

function checkRow(row: CsvRow, charset: GameCharset, confirmedSourceChars: ConfirmedSourceChars) {
  const id = getRequired(row, "id");
  const problems: string[] = [];
  const translation = getCell(row, "translation", problems);
  const rawLengthText = getCell(row, "raw_length", problems);
  const encoding = parseEncoding(row, problems);

  if (translation.length === 0) {
    problems.push("translation 为空");
  }

  if (!/^\d+$/.test(rawLengthText)) {
    problems.push(`raw_length 不是非负整数：${rawLengthText}`);
    return { id, problems, byteLength: 0, rawLength: 0 };
  }

  const rawLength = Number(rawLengthText);
  if (!Number.isSafeInteger(rawLength)) {
    problems.push(`raw_length 不是安全整数：${rawLengthText}`);
    return { id, problems, byteLength: 0, rawLength: 0 };
  }

  if (encoding === null) {
    return { id, problems, byteLength: 0, rawLength };
  }

  const problemCountBeforeEncode = problems.length;
  const encoded = encodeText(translation, encoding, problems);
  const roundtrip = decodeText(encoded, encoding);

  if (problems.length === problemCountBeforeEncode && roundtrip !== translation) {
    problems.push(`译文不能用 ${encoding} 无损编码，回读结果：${roundtrip}`);
  }

  checkGameCharset(translation, encoding, charset, confirmedSourceChars, problems);

  if (encoded.length > rawLength) {
    problems.push(`译文字节数超限：${encoded.length} > ${rawLength}`);
  }

  return { id, problems, byteLength: encoded.length, rawLength };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    throw new Error("请传入至少一个 id，例如：yarn check-ids story.dat:2109:0:0x45D260，或使用 yarn check-ids all");
  }

  if (!existsSync(translatedCsvPath)) {
    throw new Error(`找不到翻译表：${translatedCsvPath}`);
  }

  const rows = parseCsv(readFileSync(translatedCsvPath, "utf8"));
  const charset = loadGameCharset();
  const confirmedSourceChars = loadConfirmedSourceChars();
  const rowsById = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const id = getRequired(row, "id");
    rowsById.set(id, [...(rowsById.get(id) ?? []), row]);
  }
  const ids =
    args.length === 1 && args[0] === "all"
      ? rows.filter((row) => getRequired(row, "translation").length > 0).map((row) => getRequired(row, "id"))
      : args;

  if (ids.length === 0) {
    console.log("全部通过：0/0");
    return;
  }

  const results: Array<{
    id: string;
    ok: boolean;
    byteLength?: number;
    rawLength?: number;
    problems: string[];
  }> = [];

  for (const id of ids) {
    const matchedRows = rowsById.get(id);
    if (!matchedRows) {
      results.push({ id, ok: false, problems: ["找不到该 id"] });
      continue;
    }
    if (matchedRows.length > 1) {
      results.push({ id, ok: false, problems: ["translated.csv 中有重复 id"] });
      continue;
    }

    const row = matchedRows[0]!;
    const result = checkRow(row, charset, confirmedSourceChars);
    results.push({
      id,
      ok: result.problems.length === 0,
      byteLength: result.byteLength,
      rawLength: result.rawLength,
      problems: result.problems,
    });
  }

  for (const item of results.filter((result) => !result.ok)) {
    console.log(`id: ${item.id}`);
    console.log(`状态: ${item.ok ? "通过" : "未通过"}`);
    console.log(
      `字节: ${
        item.byteLength !== undefined && item.rawLength !== undefined
          ? `${item.byteLength}/${item.rawLength}`
          : "-"
      }`,
    );
    if (item.problems.length > 0) {
      console.log(`问题: ${item.problems.join("；")}`);
    }
    console.log("");
  }

  const passedCount = results.filter((item) => item.ok).length;
  const failedCount = results.length - passedCount;
  if (failedCount === 0) {
    console.log(`全部通过：${passedCount}/${ids.length}`);
    return;
  }

  console.log(`未全部通过：${passedCount}/${ids.length}`);
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
