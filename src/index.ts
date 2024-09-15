import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import debugLib from "debug";
import { glob } from "glob";
import { type LilconfigResult, lilconfig } from "lilconfig";

const debug = debugLib("hash-runner");

export interface HashRunnerConfig {
  /**
   * An array of glob patterns to include files for hashing.
   */
  include?: string[];
  /**
   * An array of glob patterns to exclude files from hashing.
   * `node_modules` is always excluded.
   */
  exclude?: string[];
  /**
   * The command to execute when changes are detected.
   */
  execOnChange: string;
  /**
   * The name of the file to store the hashes.
   * This should also be included in the `.gitignore` file.
   */
  hashFile: string;
}

const CI = process.env.CI === "true";

/**
 * The number of entries to generate a hash comparison chunk
 * for parallel comparison.
 */
const COMPARISON_CHUNK_SIZE = 100;

/**
 * Exits the process with the provided exit code.
 * @param {number} code - The exit code.
 */
function exitProcess(code: number): void {
  if (process.env.IS_TEST) {
    return;
  }

  process.exit(code);
}

/**
 * Runs a shell command in the specified working directory.
 * @param {string} command - The command to run.
 * @param {string} cwd - The working directory.
 * @returns {Promise<number>} - Resolves with the exit code of the command.
 */
async function runCommand(command: string, cwd: string): Promise<number> {
  debug(`Running command: "${command}"`);

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

/**
 * Computes the SHA-256 hash of a file.
 * @param {string} filePath - The path to the file.
 * @returns {Promise<string>} - Resolves with the hash of the file.
 */
async function computeFileHash(filePath: string): Promise<string> {
  const fileBuffer = await fs.readFile(filePath);
  const hashSum = createHash("sha256");
  hashSum.update(fileBuffer);
  return hashSum.digest("hex");
}

/**
 * Retrieves the hashes of the files that match the configuration patterns.
 * @param {string} configDir - The directory containing the configuration.
 * @param {HashRunnerConfig} config - The hash runner configuration.
 * @returns {Promise<Record<string, string>>} - Resolves with an object mapping file paths to their hashes.
 */
async function getHashedFiles(configDir: string, config: HashRunnerConfig): Promise<Record<string, string>> {
  const includePatterns = config.include || [];
  const excludePatterns = [...(config.exclude || []), "node_modules/**"];

  const includedFiles = await glob(includePatterns.join("|"), {
    cwd: configDir,
    dot: true,
    absolute: true,
    ignore: excludePatterns,
    nodir: true,
  });

  const fileHashes: Record<string, string> = {};

  // Compute hashes for all included files
  await Promise.all(
    includedFiles.map(async (file) => {
      const relativePath = path.relative(configDir, file);
      fileHashes[relativePath] = await computeFileHash(file);
    }),
  );

  return fileHashes;
}

/**
 * Loads the hash runner configuration.
 * @param {string} [specificConfigPath] - Specific path to the configuration file.
 * @returns {Promise<{ config: HashRunnerConfig; configDir: string }>} - Resolves with the configuration and its directory.
 */
async function loadConfig(specificConfigPath?: string): Promise<{ config: HashRunnerConfig; configDir: string }> {
  const explorer = lilconfig("hash-runner");
  let result: LilconfigResult;

  if (specificConfigPath) {
    result = await explorer.load(specificConfigPath);
  } else {
    result = await explorer.search();
  }

  if (!result || result.isEmpty) {
    throw new Error("[hash-runner] Config file not found or is empty");
  }

  return { config: result.config, configDir: path.dirname(result.filepath) };
}

/**
 * Reads the hashes stored in the hash file.
 * @param {string} hashFilePath - The path to the hash file.
 * @returns {Promise<Record<string, string>>} - Resolves with the hashes read from the file.
 */
async function readHashFile(hashFilePath: string): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(hashFilePath, "utf8");
    return JSON.parse(content);
  } catch (e) {
    return {};
  }
}

/**
 * Writes the hash data to the hash file.
 * @param {string} hashFilePath - The path to the hash file.
 * @param {Record<string, string>} hashData - The hash data to write.
 */
async function writeHashFile(hashFilePath: string, hashData: Record<string, string>) {
  await fs.writeFile(hashFilePath, JSON.stringify(hashData, null, 2));
}

/**
 * Checks if there are any changes in the file hashes in parallel using chunked comparison and AbortController.
 * A chunk is generated per `chunkSize` number of files. If a change is detected in any chunk,
 * the operation of all chunk comparisons are aborted.
 * @param {Record<string, string>} currentHashes - The current file hashes.
 * @param {Record<string, string>} previousHashes - The previous file hashes.
 * @param {number} [chunkSize=COMPARISON_CHUNK_SIZE] - The size of each chunk for comparison.
 * @returns {Promise<boolean>} - Resolves with true if changes are detected, otherwise false.
 */
async function checkChangesInChunks(
  currentHashes: Record<string, string>,
  previousHashes: Record<string, string>,
  chunkSize: number = COMPARISON_CHUNK_SIZE,
): Promise<boolean> {
  const fileKeys = Object.keys(currentHashes);
  const numCursors = Math.ceil(fileKeys.length / chunkSize);
  const abortController = new AbortController();

  // Function to check a chunk of file hashes for changes
  async function checkChunk(startIndex: number, endIndex: number, signal: AbortSignal): Promise<void> {
    for (let i = startIndex; i < endIndex; i++) {
      if (signal.aborted) {
        return; // Return immediately if the operation is aborted
      }

      const file = fileKeys[i];
      if (currentHashes[file] !== previousHashes[file]) {
        abortController.abort(); // Abort other operations if a change is detected
        return;
      }
    }
  }

  // Create an array of promises, where each promise corresponds to checking a chunk of file hashes.
  const promises = Array.from(
    { length: numCursors }, // Set the length of the array to numCursors
    (_, cursor) => {
      // Mapping function: _ is the current value (ignored), and cursor is the index

      // Calculate the starting index of the current chunk
      const startIndex = cursor * chunkSize;

      // Calculate the ending index of the current chunk.
      // Ensure it does not exceed the total number of file keys.
      const endIndex = Math.min(startIndex + chunkSize, fileKeys.length);

      // Call the checkChunk function with the start and end indices of the current chunk
      // and the abort signal to handle early termination.
      return checkChunk(startIndex, endIndex, abortController.signal);
    },
  );

  try {
    await Promise.all(promises);
  } catch (err: any) {
    if (err?.name !== "AbortError") {
      throw err; // If the error is not an abort error, propagate it
    }
  }

  return abortController.signal.aborted;
}

/**
 * Main function to run the hash runner process.
 * @param {string} [configPath] - Specific path to the configuration file.
 */
export async function hashRunner(configPath?: string) {
  const { config, configDir } = await loadConfig(configPath);
  const hashFilePath = path.join(configDir, config.hashFile);

  if (CI) {
    debug("CI environment detected. Bypassing hash check.");
    const code = await runCommand(config.execOnChange, configDir);
    exitProcess(code);
    return;
  }

  const [previousHashes, currentHashes] = await Promise.all([
    readHashFile(hashFilePath),
    getHashedFiles(configDir, config),
  ]);

  // Check if any files have changes using the chunked async check
  const hasChanges = await checkChangesInChunks(currentHashes, previousHashes);

  if (!hasChanges) {
    debug(`No changes detected, skipping command execution: ${config.execOnChange}`);
    return;
  }

  const code = await runCommand(config.execOnChange, configDir);

  // Update the hash file with the new hashes
  await writeHashFile(hashFilePath, currentHashes);

  exitProcess(code);
}
