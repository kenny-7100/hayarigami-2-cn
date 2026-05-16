import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const originalCsvPath = join(rootDir, "workspace", "original.csv");
const translatedCsvPath = join(rootDir, "workspace", "translated.csv");

const requiredColumns = ["id", "status", "translation"] as const;

type RequiredColumn = (typeof requiredColumns)[number];
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

function parseCsv(path: string) {
  const content = readFileSync(path, "utf8");
  const lines = content.trimEnd().split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error(`${path} 为空`);
  }

  const header = parseCsvLine(lines[0]!);
  const missing = requiredColumns.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`${path} 缺少列：${missing.join(", ")}`);
  }

  return lines.slice(1).map((line, lineIndex) => {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) {
      throw new Error(`${path} 第 ${lineIndex + 2} 行列数不匹配：${fields.length} != ${header.length}`);
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

function getDuplicateIds(rows: CsvRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const id = getRequired(row, "id");
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

type MissingRange = {
  startId: string;
  endId: string;
  count: number;
};

function formatPercent(covered: number, total: number) {
  if (total === 0) {
    return "100.00%";
  }
  return `${((covered / total) * 100).toFixed(2)}%`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    throw new Error("coverage 不需要参数，请运行：yarn coverage");
  }

  if (!existsSync(originalCsvPath)) {
    throw new Error(`找不到原文表：${originalCsvPath}`);
  }
  if (!existsSync(translatedCsvPath)) {
    throw new Error(`找不到翻译表：${translatedCsvPath}`);
  }

  const originalRows = parseCsv(originalCsvPath);
  const translatedRows = parseCsv(translatedCsvPath);
  const originalDuplicateIds = getDuplicateIds(originalRows);
  const translatedDuplicateIds = getDuplicateIds(translatedRows);

  if (originalDuplicateIds.length > 0 || translatedDuplicateIds.length > 0) {
    for (const id of originalDuplicateIds) {
      console.log(`id: ${id}`);
      console.log("状态: 未通过");
      console.log("问题: original.csv 中有重复 id");
      console.log("");
    }
    for (const id of translatedDuplicateIds) {
      console.log(`id: ${id}`);
      console.log("状态: 未通过");
      console.log("问题: translated.csv 中有重复 id");
      console.log("");
    }
    console.log("覆盖检查失败：存在重复 id");
    process.exit(1);
  }

  const targetOriginalRows = originalRows.filter((row) => getRequired(row, "status") === "confirmed");
  const allOriginalIds = originalRows.map((row) => getRequired(row, "id"));
  const originalIds = targetOriginalRows.map((row) => getRequired(row, "id"));
  const originalIdSet = new Set(originalIds);
  const allOriginalIdSet = new Set(allOriginalIds);
  const translatedIdsWithText = translatedRows
    .filter((row) => getRequired(row, "translation").length > 0)
    .map((row) => getRequired(row, "id"));
  const unknownTranslatedIds = translatedIdsWithText.filter((id) => !allOriginalIdSet.has(id));

  if (unknownTranslatedIds.length > 0) {
    for (const id of unknownTranslatedIds) {
      console.log(`id: ${id}`);
      console.log("状态: 未通过");
      console.log("问题: translated.csv 中存在 original.csv 没有的 id");
      console.log("");
    }
    console.log("覆盖检查失败：存在未知翻译 id");
    process.exit(1);
  }

  const coveredIds = new Set(translatedIdsWithText.filter((id) => originalIdSet.has(id)));

  const missingRanges: MissingRange[] = [];
  let currentRange: MissingRange | null = null;

  for (const id of originalIds) {
    if (coveredIds.has(id)) {
      if (currentRange !== null) {
        missingRanges.push(currentRange);
        currentRange = null;
      }
      continue;
    }

    if (currentRange === null) {
      currentRange = { startId: id, endId: id, count: 1 };
    } else {
      currentRange.endId = id;
      currentRange.count += 1;
    }
  }

  if (currentRange !== null) {
    missingRanges.push(currentRange);
  }

  const total = originalIds.length;
  const covered = total - missingRanges.reduce((sum, range) => sum + range.count, 0);

  if (missingRanges.length === 0) {
    console.log("统计范围：original.status=confirmed");
    console.log(`全部覆盖：${covered}/${total}`);
    console.log(`覆盖率：${formatPercent(covered, total)}`);
    return;
  }

  const missingCount = total - covered;

  console.log("统计范围：original.status=confirmed");

  console.log(`未覆盖数：${missingCount}`);
  console.log(`未覆盖区间数：${missingRanges.length}`);
  console.log("未覆盖区间:");
  for (const range of missingRanges) {
    console.log(`- 开始: ${range.startId}`);
    console.log(`  结束: ${range.endId}`);
    console.log(`  数量: ${range.count}`);
  }
  console.log("");
  console.log(`覆盖未完成：${covered}/${total}`);
  console.log(`覆盖率：${formatPercent(covered, total)}`);
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
