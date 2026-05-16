import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const ppssppPath = "/Applications/PPSSPPSDL.app/Contents/MacOS/PPSSPPSDL";
const logDir = join(rootDir, "logs");

const runTarget = process.argv[2];
const runConfig =
  runTarget === "1"
    ? {
        label: "原始镜像 game/1.iso",
        logPrefix: "run1",
        isoPath: join(rootDir, "game", "1.iso"),
      }
    : runTarget === "2"
      ? {
          label: "构建镜像 build/2.iso",
          logPrefix: "run2",
          isoPath: join(rootDir, "build", "2.iso"),
        }
      : null;

if (!runConfig) {
  throw new Error("请指定运行目标：1 或 2");
}

const runLogPath = join(logDir, `${runConfig.logPrefix}.log`);
const ppssppLogPath = join(logDir, `${runConfig.logPrefix}.ppsspp.log`);

if (!existsSync(runConfig.isoPath)) {
  throw new Error(`找不到 ISO 文件：${runConfig.isoPath}`);
}

if (!existsSync(ppssppPath)) {
  throw new Error(`找不到 PPSSPP 可执行文件：${ppssppPath}`);
}

mkdirSync(logDir, { recursive: true });
rmSync(ppssppLogPath, { force: true });

const args = [
  "-d",
  "-v",
  "--loglevel=5",
  `--log=${ppssppLogPath}`,
  "--windowed",
  "--pause-menu-exit",
  "--escape-exit",
  runConfig.isoPath,
];

const isoStat = statSync(runConfig.isoPath);

writeFileSync(
  runLogPath,
  [
    `启动时间：${new Date().toISOString()}`,
    `运行目标：${runConfig.label}`,
    `ISO 路径：${runConfig.isoPath}`,
    `ISO 大小：${isoStat.size} 字节`,
    `PPSSPP 路径：${ppssppPath}`,
    `PPSSPP 日志：${ppssppLogPath}`,
    `启动参数：${args.join(" ")}`,
    "",
  ].join("\n"),
);

console.log(`正在以调试模式运行${runConfig.label}：${runConfig.isoPath}`);
console.log(`运行日志：${runLogPath}`);
console.log(`PPSSPP 日志：${ppssppLogPath}`);

const runLogStream = createWriteStream(runLogPath, { flags: "a" });
const child = spawn(ppssppPath, args, {
  stdio: ["ignore", "pipe", "pipe"],
});

runLogStream.write("===== stdout/stderr =====\n");

child.stdout.on("data", (chunk: Buffer) => {
  process.stdout.write(chunk);
  runLogStream.write(chunk);
});

child.stderr.on("data", (chunk: Buffer) => {
  process.stderr.write(chunk);
  runLogStream.write(chunk);
});

const exitCode = await new Promise<number>((resolveExit, reject) => {
  child.on("error", reject);
  child.on("close", (code) => resolveExit(code ?? 0));
});

await new Promise<void>((resolveFinish) =>
  runLogStream.end(
    [
      "",
      "===== 运行结束 =====",
      `退出状态：${exitCode}`,
      `结束时间：${new Date().toISOString()}`,
      "",
    ].join("\n"),
    resolveFinish,
  ),
);

if (exitCode !== 0) {
  process.exit(exitCode);
}

console.log(`已结束调试运行：${runConfig.isoPath}`);
