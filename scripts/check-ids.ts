import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import iconv from "iconv-lite";

const rootDir = resolve(import.meta.dirname, "..");
const translatedCsvPath = join(rootDir, "workspace", "translated.csv");

const requiredColumns = ["id", "encoding", "raw_length", "translation"] as const;

type RequiredColumn = (typeof requiredColumns)[number];
type EncodingName = "shift_jis" | "cp932" | "utf-8" | "ascii";
type CsvRow = Record<string, string> & { lineNumber: string };

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

function checkRow(row: CsvRow) {
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
    const result = checkRow(row);
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
