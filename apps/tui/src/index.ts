#!/usr/bin/env node
import { runWorkspace } from "./run";
import { clean } from "./screen";
runWorkspace().catch((error) => {
  process.stderr.write(`${clean(error.message)}\n`);
  process.exitCode = 1;
});
