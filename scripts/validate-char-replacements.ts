import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import iconv from "iconv-lite";
import { preferredCharReplacements } from "./game-char-replacements.js";

const rootDir = resolve(import.meta.dirname, "..");
const originalCsvPath = join(rootDir, "workspace", "original.csv");
const dataDatPath = join(rootDir, "output", "PSP_GAME", "USRDIR", "DATA.DAT");

const nispackMagic = Buffer.from("NISPACK\x00", "ascii");
const nispackHeaderSize = 16;
const nispackEntrySize = 44;

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
  return lines.slice(1).map((line, lineIndex) => {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) {
      throw new Error(`CSV 第 ${lineIndex + 2} 行列数不匹配：${fields.length} != ${header.length}`);
    }

    const row: Record<string, string> = {};
    header.forEach((name, index) => {
      row[name] = fields[index] ?? "";
    });
    return row;
  });
}

function loadConfirmedSourceChars() {
  if (!existsSync(originalCsvPath)) {
    throw new Error(`找不到原文表：${originalCsvPath}`);
  }

  const chars = new Set<string>();
  for (const row of parseCsv(readFileSync(originalCsvPath, "utf8"))) {
    if (row.status !== "confirmed") {
      continue;
    }
    for (const char of row.source ?? "") {
      chars.add(char);
    }
  }
  return chars;
}

function loadJis2ucs() {
  if (!existsSync(dataDatPath)) {
    throw new Error(`找不到 DATA.DAT：${dataDatPath}`);
  }

  const data = readFileSync(dataDatPath);
  const base = data.indexOf(nispackMagic);
  if (base < 0) {
    throw new Error("DATA.DAT 中找不到 NISPACK 头");
  }

  const count = data.readUInt32LE(base + 12);
  for (let index = 0; index < count; index += 1) {
    const entryOffset = base + nispackHeaderSize + index * nispackEntrySize;
    const rawName = data.subarray(entryOffset, entryOffset + 32);
    const nul = rawName.indexOf(0);
    const name = rawName.subarray(0, nul < 0 ? rawName.length : nul).toString("ascii");
    const relativeOffset = data.readUInt32LE(entryOffset + 32);
    const size = data.readUInt32LE(entryOffset + 36);
    const absoluteOffset = base + relativeOffset;
    if (name === "jis2ucs.bin") {
      if (size !== 65536 * 2) {
        throw new Error(`jis2ucs.bin 大小异常：${size}`);
      }
      return data.subarray(absoluteOffset, absoluteOffset + size);
    }
  }

  throw new Error("DATA.DAT/NISPACK 中找不到 jis2ucs.bin");
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

  return (row << 8) | cell;
}

function isInGameCharset(char: string, jis2ucs: Buffer) {
  const encoded = iconv.encode(char, "shift_jis");
  const jisCode = sjisBytesToJisCode(encoded);
  if (jisCode === null) {
    return false;
  }
  return jis2ucs.readUInt16LE(jisCode * 2) === char.codePointAt(0);
}

function main() {
  const confirmedSourceChars = loadConfirmedSourceChars();
  const jis2ucs = loadJis2ucs();
  const errors: string[] = [];

  for (const [source, replacement] of preferredCharReplacements) {
    const sourceSafe = confirmedSourceChars.has(source) && isInGameCharset(source, jis2ucs);
    const replacementSafe = confirmedSourceChars.has(replacement) && isInGameCharset(replacement, jis2ucs);
    if (source === replacement) {
      errors.push(`${source} -> ${replacement}: source 和 replacement 相同`);
    }
    if (sourceSafe) {
      errors.push(`${source} -> ${replacement}: source 已经有 confirmed 显示样本`);
    }
    if (!replacementSafe) {
      errors.push(`${source} -> ${replacement}: replacement 没有 confirmed 显示样本或不在 jis2ucs`);
    }
  }

  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  console.log(`替换表通过：${preferredCharReplacements.size} 条`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
