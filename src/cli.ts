#!/usr/bin/env node
/* v8 ignore file -- The `bin` shim runs on import, so it cannot be covered in-process and a subprocess reports
   nothing back. Everything it calls is covered directly. */
import { configureLogging, main } from "./index.js";

await configureLogging();

// Bound on its own line so the directive stays next to what it exempts when the formatter rewraps the call below.
// eslint-disable-next-line node/no-process-env -- This is the CLI entry point.
const environment = process.env;

process.exitCode = await main({ argumentList: process.argv.slice(2), directory: process.cwd(), environment });
