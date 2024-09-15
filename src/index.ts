import { exec } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import util from "node:util";
import { type CosmiconfigResult, cosmiconfig } from "cosmiconfig";
import { glob } from "glob";

export interface HashRunnerConfig {
  include?: string[];
  exclude?: string[];
  execOnChange: string;
  hashFile: string;
}

const CI = process.env.CI === "true";
const execPromise = util.promisify(exec);

async function runCommand(command: string, cwd: string) {
  await execPromise(command, { cwd });
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
  const explorer = cosmiconfig("hash-runner");
  let result: CosmiconfigResult;

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
    await runCommand(config.execOnChange, configDir);
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

  await runCommand(config.execOnChange, configDir);

  // Update the hash file with the new hashes
  await writeHashFile(hashFilePath, currentHashes);
}
