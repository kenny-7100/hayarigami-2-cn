import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const inputIso = join(rootDir, "game", "1.iso");
const outputDir = join(rootDir, "output");

function cleanOutputDir() {
  mkdirSync(outputDir, { recursive: true });

  for (const entry of readdirSync(outputDir)) {
    rmSync(join(outputDir, entry), { recursive: true, force: true });
  }
}

if (!existsSync(inputIso)) {
  throw new Error(`找不到输入 ISO：${inputIso}`);
}

cleanOutputDir();

const result = spawnSync("bsdtar", ["-xf", inputIso, "-C", outputDir], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`已将 ${inputIso} 解包到 ${outputDir}`);
