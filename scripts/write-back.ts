import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import iconv from "iconv-lite";

const rootDir = resolve(import.meta.dirname, "..");
const outputDir = join(rootDir, "output");
const translatedCsvPath = join(rootDir, "workspace", "translated.csv");
const dataDatPath = join(outputDir, "PSP_GAME", "USRDIR", "DATA.DAT");

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

function encodeTranslation(row: CsvRow) {
  const translation = getRequired(row, "translation");
  const encoding = parseEncoding(row);
  const transform = parseTransform(row);
  const rawLength = parsePositiveInteger(row, "raw_length");
  const encoded = encodeText(translation, encoding);
  const roundtrip = decodeText(encoded, encoding);

  if (roundtrip !== translation) {
    throw new Error(`行 ${row.id} 的译文不能用 ${encoding} 无损编码：${translation} -> ${roundtrip}`);
  }

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

function applyPatch(fileCache: Map<string, Buffer>, row: CsvRow) {
  const { filePath, offset } = outputFileForRow(row);
  const { padded, byteLength, rawLength } = encodeTranslation(row);

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
  const translatedRows = rows.filter((row) => getRequired(row, "translation").length > 0);
  const skipped = translatedRows.filter((row) => getRequired(row, "status") !== "confirmed");
  if (skipped.length > 0) {
    throw new Error(`translated.csv 包含非 confirmed 译文，已拒绝写回：${skipped.map((row) => row.id).join(", ")}`);
  }

  const fileCache = new Map<string, Buffer>();
  const applied = translatedRows.map((row) => applyPatch(fileCache, row));

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

main();
