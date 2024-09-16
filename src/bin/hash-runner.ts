#!/usr/bin/env node

import { Command } from "commander";
import { hashRunner } from "../index";

const program = new Command();

program.option("-c, --config <path>", "specify the path to the configuration file").parse(process.argv);
program.option("-f, --force", "Force hash-regeneration and execute").parse(process.argv);

const options = program.opts();
const configPath = options.config;

hashRunner(configPath).catch((error) => {
  console.error("Error running hash runner:", error);
  process.exit(1);
});
