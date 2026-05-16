import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const outputDir = join(rootDir, "output");
const buildDir = join(rootDir, "build");
const inputIso = join(rootDir, "game", "1.iso");
const targetIso = join(buildDir, "2.iso");

function calculateMd5(filePath: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

mkdirSync(outputDir, { recursive: true });
mkdirSync(buildDir, { recursive: true });
rmSync(targetIso, { force: true });

if (readdirSync(outputDir).length === 0) {
  throw new Error(`输出目录为空：${outputDir}`);
}

console.log("正在生成新的 ISO...");

const result = spawnSync(
  "hdiutil",
  [
    "makehybrid",
    "-iso",
    "-default-volume-name",
    "HAYARIGAMI_2_CN",
    "-o",
    targetIso,
    outputDir,
  ],
  { encoding: "utf8" },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  if (result.stdout) {
    console.error(result.stdout);
  }

  if (result.stderr) {
    console.error(result.stderr);
  }

  process.exit(result.status ?? 1);
}

console.log(`已根据 ${outputDir} 重新打包为 ${targetIso}`);

const [inputMd5, targetMd5] = await Promise.all([
  calculateMd5(inputIso),
  calculateMd5(targetIso),
]);

console.log("MD5 对比：");
console.log(`1.iso：${inputMd5}`);
console.log(`2.iso：${targetMd5}`);
