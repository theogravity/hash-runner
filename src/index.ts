import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import debugLib from "debug";
import { glob } from "glob";
import { type LilconfigResult, lilconfig } from "lilconfig";

const debug = debugLib("hash-runner");

export interface HashRunnerConfigFile {
  include?: string[];
  exclude?: string[];
  execOnChange: string;
  hashFile: string;
  parallelizeComparisonsChunkSize?: number;
}

export interface HashRunnerOptions {
  force?: boolean;
  silent?: boolean;
}

const CI = process.env.CI === "true";
const COMPARISON_CHUNK_SIZE = 100;

/**
 * Class representing a HashRunner that detects file changes and runs a command.
 */
export class HashRunner {
  configPath?: string;
  options: HashRunnerOptions;

  /**
   * Constructs a new HashRunner.
   * @param {string} [configPath] - Path to the configuration file.
   * @param {HashRunnerOptions} [options={}] - Options for the HashRunner.
   */
  constructor(configPath?: string, options: HashRunnerOptions = {}) {
    this.configPath = configPath;
    this.options = options;
  }

  /**
   * Exits the process with a given exit code.
   * @param {number} code - Exit code.
   * @private
   */
  private exitProcess(code: number): void {
    if (process.env.IS_TEST) {
      return;
    }
    process.exit(code);
  }

  /**
   * Logs a message to the console if not in silent mode.
   * @param {string} message - The message to log.
   * @private
   */
  private log(message: string): void {
    if (!this.options.silent) {
      console.log(`[hash-runner] ${message}`);
    }
  }

  /**
   * Runs a given command in a child process.
   * @param {string} command - The command to run.
   * @param {string} cwd - The current working directory.
   * @returns {Promise<number>} - Resolves with the exit code of the command.
   * @private
   */
  private async runCommand(command: string, cwd: string): Promise<number> {
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
   * Computes the hash of a given file using SHA-256.
   * @param {string} filePath - Path to the file.
   * @returns {Promise<string>} - The computed hash.
   * @private
   */
  private async computeFileHash(filePath: string): Promise<string> {
    debug(`Computing hash for file: "${filePath}"`);
    const fileBuffer = await fs.readFile(filePath);
    const hashSum = createHash("sha256");
    hashSum.update(fileBuffer);
    return hashSum.digest("hex");
  }

  /**
   * Gets the hashes of files included in the configuration.
   * @param {string} configDir - Directory containing the configuration.
   * @param {HashRunnerConfigFile} config - Configuration object.
   * @returns {Promise<Record<string, string>>} - A record of file paths and their corresponding hashes.
   * @private
   */
  private async getHashedFiles(configDir: string, config: HashRunnerConfigFile): Promise<Record<string, string>> {
    const includePatterns = config.include || [];
    const excludePatterns = [...(config.exclude || []), "node_modules/**"];

    const includedFiles = await glob(includePatterns, {
      cwd: configDir,
      dot: true,
      absolute: true,
      ignore: excludePatterns,
      nodir: true,
    });

    const fileHashes: Record<string, string> = {};

    await Promise.all(
      includedFiles.map(async (file) => {
        const relativePath = path.relative(configDir, file);
        fileHashes[relativePath] = await this.computeFileHash(file);
      }),
    );

    return fileHashes;
  }

  /**
   * Loads the configuration from a file.
   * @returns {Promise<{ config: HashRunnerConfigFile; configDir: string }>} - The configuration and its directory.
   * @throws {Error} - Throws an error if the config file is not found or is empty.
   * @private
   */
  private async loadConfig(): Promise<{ config: HashRunnerConfigFile; configDir: string }> {
    const explorer = lilconfig("hash-runner");
    let result: LilconfigResult;

    if (this.configPath) {
      result = await explorer.load(this.configPath);
    } else {
      result = await explorer.search();
    }

    if (!result || result.isEmpty) {
      throw new Error("[hash-runner] Config file not found or is empty");
    }

    return { config: result.config, configDir: path.dirname(result.filepath) };
  }

  /**
   * Reads the hash file containing previous file hashes.
   * @param {string} hashFilePath - Path to the hash file.
   * @returns {Promise<Record<string, string> | null>} - The previous hashes or null if file not found.
   * @private
   */
  private async readHashFile(hashFilePath: string): Promise<Record<string, string> | null> {
    try {
      const content = await fs.readFile(hashFilePath, "utf8");
      return JSON.parse(content);
    } catch (e) {
      return null;
    }
  }

  /**
   * Writes the provided hash data to a file.
   * @param {string} hashFilePath - Path to the hash file.
   * @param {Record<string, string>} hashData - The hash data to write.
   * @returns {Promise<void>}
   * @private
   */
  private async writeHashFile(hashFilePath: string, hashData: Record<string, string>): Promise<void> {
    await fs.writeFile(hashFilePath, JSON.stringify(hashData, null, 2));
  }

  /**
   * Checks if there are changes between current and previous file hashes in chunks.
   * @param {Record<string, string>} currentHashes - The current file hashes.
   * @param {Record<string, string>} previousHashes - The previous file hashes.
   * @param {number} [chunkSize=COMPARISON_CHUNK_SIZE] - Chunk size for parallel comparisons.
   * @returns {Promise<boolean>} - Resolves to true if changes are detected, otherwise false.
   * @private
   */
  private async checkChangesInChunks(
    currentHashes: Record<string, string>,
    previousHashes: Record<string, string>,
    chunkSize: number = COMPARISON_CHUNK_SIZE,
  ): Promise<boolean> {
    const fileKeys = Object.keys(currentHashes);
    const numCursors = Math.ceil(fileKeys.length / chunkSize);
    const abortController = new AbortController();

    /**
     * Checks a chunk of files for hash mismatches.
     * @param {number} startIndex - Start index of the chunk.
     * @param {number} endIndex - End index of the chunk.
     * @param {AbortSignal} signal - Abort signal to halt the operation if changes are detected.
     * @returns {Promise<void>}
     */
    async function checkChunk(startIndex: number, endIndex: number, signal: AbortSignal): Promise<void> {
      for (let i = startIndex; i < endIndex; i++) {
        if (signal.aborted) return; // Return immediately if the operation is aborted

        const file = fileKeys[i];
        if (currentHashes[file] !== previousHashes[file]) {
          debug(`Hash mismatch detected for file: "${file} (${currentHashes[file]} vs ${previousHashes[file]})"`);
          abortController.abort(); // Abort other operations if a change is detected
          return;
        }
      }
    }

    // Set the length of the array to numCursors
    const promises = Array.from({ length: numCursors }, (_, cursor) => {
      // Calculate the starting index of the current chunk
      const startIndex = cursor * chunkSize;

      // Calculate the ending index of the current chunk.
      // Ensure it does not exceed the total number of file keys.
      const endIndex = Math.min(startIndex + chunkSize, fileKeys.length);

      // Call the checkChunk function with the start and end indices of the current chunk
      // and the abort signal to handle early termination.
      return checkChunk(startIndex, endIndex, abortController.signal);
    });

    try {
      debug(`Comparing hashes in ${numCursors} chunks of ${chunkSize} files each`);
      await Promise.all(promises);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        throw err;
      }
    }

    return abortController.signal.aborted;
  }

  /**
   * Main function to run the hash runner.
   * @returns {Promise<void>}
   */
  public async run(): Promise<void> {
    const { config, configDir } = await this.loadConfig();
    const hashFilePath = path.join(configDir, config.hashFile);

    if (CI) {
      this.log("CI environment detected. Bypassing hash check.");
      const code = await this.runCommand(config.execOnChange, configDir);
      this.exitProcess(code);
      return;
    }

    const [previousHashes, currentHashes] = await Promise.all([
      this.readHashFile(hashFilePath),
      this.getHashedFiles(configDir, config),
    ]);

    debug(`Forced hash regeneration: ${!!this.options.force}`);
    debug(`Previous hashes exist: ${!!previousHashes}`);
    debug(
      `Previous vs current hash length: ${Object.keys(previousHashes || {}).length} vs ${Object.keys(currentHashes).length}`,
    );

    if (
      this.options.force ||
      !previousHashes ||
      Object.keys(currentHashes).length !== Object.keys(previousHashes).length ||
      (await this.checkChangesInChunks(currentHashes, previousHashes, config.parallelizeComparisonsChunkSize))
    ) {
      this.log(`Changes detected. Running command: "${config.execOnChange}"`);
      const code = await this.runCommand(config.execOnChange, configDir);

      await this.writeHashFile(hashFilePath, currentHashes);

      // Exit the process with the command's exit code
      this.exitProcess(code);
      return;
    }

    // If no changes are detected, log and exit
    this.log("No changes detected. Exiting.");
  }
}
