import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { glob } from "glob";
import { type LilconfigResult, lilconfig } from "lilconfig";

export interface HashRunnerConfig {
  include?: string[];
  exclude?: string[];
  execOnChange: string;
  hashFile: string;
}

const CI = process.env.CI === "true";

function exitProcess(code: number): void {
  if (process.env.IS_TEST) {
    return;
  }

  process.exit(code);
}

async function runCommand(command: string, cwd: string): Promise<number> {
  console.log(`Running command: "${command}"`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit" });

    child.on("close", (code) => {
      resolve(code ?? 0);
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

async function computeFileHash(filePath: string): Promise<string> {
  const fileBuffer = await fs.readFile(filePath);
  const hashSum = createHash("sha256");
  hashSum.update(fileBuffer);
  return hashSum.digest("hex");
}

async function getHashedFiles(configDir: string, config: HashRunnerConfig): Promise<Record<string, string>> {
  const includePatterns = config.include || [];
  const excludePatterns = [...(config.exclude || []), "node_modules/**"];

  const includedFiles = await glob(includePatterns.join("|"), {
    cwd: configDir,
    dot: true,
    absolute: true,
    ignore: excludePatterns,
  });

  const fileHashes: Record<string, string> = {};

  await Promise.all(
    includedFiles.map(async (file) => {
      const relativePath = path.relative(configDir, file);
      fileHashes[relativePath] = await computeFileHash(file);
    }),
  );

  return fileHashes;
}

async function loadConfig(specificConfigPath?: string): Promise<{ config: HashRunnerConfig; configDir: string }> {
  const explorer = lilconfig("hash-runner");
  let result: LilconfigResult;

  if (specificConfigPath) {
    result = await explorer.load(specificConfigPath);
  } else {
    result = await explorer.search();
  }

  if (!result || result.isEmpty) {
    throw new Error("Config file not found or is empty");
  }

  return { config: result.config, configDir: path.dirname(result.filepath) };
}

async function readHashFile(hashFilePath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(hashFilePath, "utf8");
    return JSON.parse(content);
  } catch (e) {
    return {};
  }
}

async function writeHashFile(hashFilePath: string, hashData: Record<string, string>) {
  await fs.writeFile(hashFilePath, JSON.stringify(hashData, null, 2));
}

export async function hashRunner(configPath?: string) {
  const { config, configDir } = await loadConfig(configPath);
  const hashFilePath = path.join(configDir, config.hashFile);

  if (CI) {
    console.log("CI environment detected. Bypassing hash check.");
    const code = await runCommand(config.execOnChange, configDir);
    exitProcess(code);
    return;
  }

  const [previousHashes, currentHashes] = await Promise.all([
    readHashFile(hashFilePath),
    getHashedFiles(configDir, config),
  ]);

  // Find if there are any files that have changed
  const hasChanges = Object.keys(currentHashes).some((file) => currentHashes[file] !== previousHashes[file]);

  if (!hasChanges) {
    console.log("No changes detected.");
    return;
  }

  const code = await runCommand(config.execOnChange, configDir);

  // Update the hash file with the new hashes
  await writeHashFile(hashFilePath, currentHashes);

  exitProcess(code);
}
