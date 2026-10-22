#!/usr/bin/env node

import { Command } from "commander";
import { HashRunner } from "../index";

const program = new Command();

program
  .name("hash-runner")
  .option("-c, --config <path>", "specify the path to the configuration file")
  .option("-f, --force", "Force hash-regeneration and execute")
  .option("-s, --silent", "Suppress log output")
  .parse(process.argv);

const options = program.opts();
const configPath = options.config;

const hashRunner = new HashRunner(configPath, { force: options.force, silent: options.silent });

hashRunner.run().catch((error) => {
  console.error("Error running hash runner:", error);
  process.exit(1);
});
