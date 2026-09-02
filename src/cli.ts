#!/usr/bin/env node
/* v8 ignore file -- The `bin` shim runs on import, so it cannot be covered in-process and a subprocess reports
   nothing back. Everything it calls is covered directly. */
import { configureLogger, main } from "./index.js";

await configureLogger();

process.exitCode = await main();
