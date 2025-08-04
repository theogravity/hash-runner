import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import debugLib from "debug";
import { glob } from "glob";
import { type LilconfigResult, lilconfig } from "lilconfig";

const debug = debugLib("hash-runner");

export interface HashRunnerConfigFile {
  inputs: {
    includes: string[];
    excludes?: string[];
  };
  outputs?: {
    includes: string[];
    excludes?: string[];
  };
  execOnChange: string;
  hashFile: string;
  parallelizeComparisonsChunkSize?: number;
}

// Hash file structures
export interface HashFileV1 {
  [filepath: string]: string;
}

export interface HashFileV2 {
  hashSchemaVersion: "2";
  inputs: Record<string, string>;
  outputs?: Record<string, string>;
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
   * Gets the hashes of input files based on the configuration.
   * @param {string} configDir - Directory containing the configuration.
   * @param {HashRunnerConfigFile} config - Configuration object.
   * @param {string} configFilePath - Path to the configuration file to exclude from processing.
   * @returns {Promise<Record<string, string>>} - A record of file paths and their corresponding hashes.
   * @private
   */
  private async getInputHashes(
    configDir: string,
    config: HashRunnerConfigFile,
    configFilePath: string,
  ): Promise<Record<string, string>> {
    const includePatterns = config.inputs.includes;
    const excludePatterns = [...(config.inputs.excludes || [])];

    // Auto-exclude the hash file from the config using glob pattern
    excludePatterns.push(config.hashFile);

    // Auto-exclude the config file using glob pattern
    const configFileName = path.basename(configFilePath);
    excludePatterns.push(configFileName);

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
   * Gets the hashes of output files based on the configuration.
   * @param {string} configDir - Directory containing the configuration.
   * @param {HashRunnerConfigFile} config - Configuration object.
   * @param {string} configFilePath - Path to the configuration file to exclude from processing.
   * @returns {Promise<Record<string, string> | undefined>} - A record of file paths and their corresponding hashes, or undefined if no outputs configured.
   * @private
   */
  private async getOutputHashes(
    configDir: string,
    config: HashRunnerConfigFile,
    configFilePath: string,
  ): Promise<Record<string, string> | undefined> {
    if (!config.outputs) {
      return undefined;
    }

    const includePatterns = config.outputs.includes;
    const excludePatterns = [...(config.outputs.excludes || [])];

    // Auto-exclude the hash file from the config using glob pattern
    excludePatterns.push(config.hashFile);

    // Auto-exclude the config file using glob pattern
    const configFileName = path.basename(configFilePath);
    excludePatterns.push(configFileName);

    try {
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
    } catch (error) {
      // If we can't read output files (e.g., they don't exist), return undefined
      // This will be treated as a cache miss
      debug(`Could not read output files: ${error}`);
      return undefined;
    }
  }

  /**
   * Checks if outputs have changed or are missing.
   * @param {Record<string, string> | undefined} currentOutputs - Current output hashes.
   * @param {Record<string, string> | undefined} previousOutputs - Previous output hashes.
   * @returns {boolean} - True if outputs are missing or have changed.
   * @private
   */
  private checkOutputsChanged(
    currentOutputs?: Record<string, string>,
    previousOutputs?: Record<string, string>,
  ): boolean {
    // If no outputs are configured, consider them unchanged
    if (!currentOutputs && !previousOutputs) {
      return false;
    }

    // If outputs are configured but missing, consider them changed
    if (!currentOutputs && previousOutputs) {
      debug("Output files are missing, considering cache stale");
      return true;
    }

    // If outputs were not tracked before but are now configured, consider them changed
    if (currentOutputs && !previousOutputs) {
      debug("Output files are newly configured, considering cache stale");
      return true;
    }

    // Both exist, compare them
    if (currentOutputs && previousOutputs) {
      const currentKeys = Object.keys(currentOutputs);
      const previousKeys = Object.keys(previousOutputs);

      // Check if number of files changed
      if (currentKeys.length !== previousKeys.length) {
        debug(`Output files count changed: ${previousKeys.length} vs ${currentKeys.length}`);
        return true;
      }

      // Check if any hashes changed
      for (const file of currentKeys) {
        if (currentOutputs[file] !== previousOutputs[file]) {
          debug(`Output file hash changed: ${file}`);
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Loads the configuration from a file.
   * @returns {Promise<{ config: HashRunnerConfigFile; configDir: string; configFilePath: string }>} - The configuration, its directory, and file path.
   * @throws {Error} - Throws an error if the config file is not found or is empty.
   * @private
   */
  private async loadConfig(): Promise<{ config: HashRunnerConfigFile; configDir: string; configFilePath: string }> {
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

    const config = result.config;

    // Check if it's a v3 configuration
    if ("include" in config || "exclude" in config) {
      throw new Error(
        "[hash-runner] Detected v3 configuration format. Please see MIGRATING.md for migration instructions.",
      );
    }

    // Validate v4 configuration
    if (!config.inputs || !config.inputs.includes) {
      throw new Error("[hash-runner] Configuration must have inputs.includes array");
    }

    return { config, configDir: path.dirname(result.filepath), configFilePath: result.filepath };
  }

  /**
   * Reads the hash file containing previous file hashes.
   * @param {string} hashFilePath - Path to the hash file.
   * @returns {Promise<HashFileV2 | null>} - The previous hashes or null if file not found.
   * @private
   */
  private async readHashFile(hashFilePath: string): Promise<HashFileV2 | null> {
    try {
      const content = await fs.readFile(hashFilePath, "utf8");
      const parsed = JSON.parse(content);
      return this.migrateHashFile(parsed);
    } catch (_e) {
      return null;
    }
  }

  /**
   * Migrates a hash file from v1 to v2 format if needed.
   * @param {HashFileV1 | HashFileV2} hashData - The hash data to migrate.
   * @returns {HashFileV2} - The migrated hash data.
   * @private
   */
  private migrateHashFile(hashData: HashFileV1 | HashFileV2): HashFileV2 {
    // Check if it's already v2 format
    if ("hashSchemaVersion" in hashData && hashData.hashSchemaVersion === "2") {
      return hashData as HashFileV2;
    }

    // Migrate from v1 to v2
    const v1Data = hashData as HashFileV1;
    debug("Migrating hash file from v1 to v2 format");

    return {
      hashSchemaVersion: "2",
      inputs: v1Data,
      outputs: undefined,
    };
  }

  /**
   * Writes the provided hash data to a file.
   * @param {string} hashFilePath - Path to the hash file.
   * @param {Record<string, string>} inputHashes - The input hash data to write.
   * @param {Record<string, string>} outputHashes - The output hash data to write.
   * @returns {Promise<void>}
   * @private
   */
  private async writeHashFile(
    hashFilePath: string,
    inputHashes: Record<string, string>,
    outputHashes?: Record<string, string>,
  ): Promise<void> {
    // Create sorted versions of the hash data with alphabetized keys
    const sortedInputHashes = Object.keys(inputHashes)
      .sort()
      .reduce(
        (sorted, key) => {
          sorted[key] = inputHashes[key];
          return sorted;
        },
        {} as Record<string, string>,
      );

    const sortedOutputHashes = outputHashes
      ? Object.keys(outputHashes)
          .sort()
          .reduce(
            (sorted, key) => {
              sorted[key] = outputHashes[key];
              return sorted;
            },
            {} as Record<string, string>,
          )
      : undefined;

    const hashFileData: HashFileV2 = {
      hashSchemaVersion: "2",
      inputs: sortedInputHashes,
      outputs: sortedOutputHashes,
    };

    await fs.writeFile(hashFilePath, JSON.stringify(hashFileData, null, 2));
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
    const { config, configDir, configFilePath } = await this.loadConfig();
    const hashFilePath = path.join(configDir, config.hashFile);

    if (CI) {
      this.log("CI environment detected. Bypassing hash check.");
      const code = await this.runCommand(config.execOnChange, configDir);
      this.exitProcess(code);
      return;
    }

    const [previousHashFile, currentInputHashes, currentOutputHashes] = await Promise.all([
      this.readHashFile(hashFilePath),
      this.getInputHashes(configDir, config, configFilePath),
      this.getOutputHashes(configDir, config, configFilePath),
    ]);

    const previousInputHashes = previousHashFile?.inputs || {};
    const previousOutputHashes = previousHashFile?.outputs;

    debug(`Forced hash regeneration: ${!!this.options.force}`);
    debug(`Previous hash file exists: ${!!previousHashFile}`);
    debug(
      `Previous vs current input hash length: ${Object.keys(previousInputHashes).length} vs ${Object.keys(currentInputHashes).length}`,
    );
    debug(
      `Previous vs current output hash length: ${Object.keys(previousOutputHashes || {}).length} vs ${Object.keys(currentOutputHashes || {}).length}`,
    );

    // Check if we need to run the command
    const inputsChanged =
      Object.keys(currentInputHashes).length !== Object.keys(previousInputHashes).length ||
      (await this.checkChangesInChunks(
        currentInputHashes,
        previousInputHashes,
        config.parallelizeComparisonsChunkSize,
      ));

    const outputsChanged = this.checkOutputsChanged(currentOutputHashes, previousOutputHashes);

    if (this.options.force || !previousHashFile || inputsChanged || outputsChanged) {
      if (this.options.force) {
        this.log("Forced execution. Running command.");
      } else if (!previousHashFile) {
        this.log("No previous hash file found. Running command.");
      } else if (inputsChanged) {
        this.log("Input changes detected. Running command.");
      } else if (outputsChanged) {
        this.log("Output changes detected or outputs missing. Running command.");
      }

      this.log(`Running command: "${config.execOnChange}"`);
      const code = await this.runCommand(config.execOnChange, configDir);

      // After running the command, re-read output hashes in case they were generated/modified
      const updatedOutputHashes = await this.getOutputHashes(configDir, config, configFilePath);
      await this.writeHashFile(hashFilePath, currentInputHashes, updatedOutputHashes);

      // Exit the process with the command's exit code
      this.exitProcess(code);
      return;
    }

    // If no changes are detected, log and exit
    this.log("No changes detected. Exiting.");
  }
}
