/**
 * Test entry point: discovers and loads every compiled `*.test.js` beside it.
 *
 * This exists because there is no single `node --test` invocation that works
 * across the Node versions this project supports — measured on CI, 2026-09-24,
 * run 36027626531:
 *
 *   node --test "out/test/*.test.js"   Node 24 ✓   Node 20 ✗  (glob support in
 *                                                              --test landed in 21)
 *   node --test out/test              Node 24 ✗   (resolved as a module:
 *                                                  "Cannot find module .../out/test")
 *   node --test                       Node 24 ✗   (also discovers src/test/*.ts and
 *                                                  fails on its extensionless imports)
 *   node --test out/test/<file>.js    Node 24 ✓   Node 20 ✓
 *
 * So the portable form is an explicit file — and a hand-maintained list of explicit
 * files is how a test silently stops running. This file is that one explicit entry,
 * and it finds the rest itself.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const here = __dirname;
const testFiles = readdirSync(here)
  .filter((name) => name.endsWith('.test.js'))
  .sort();

if (testFiles.length === 0) {
  // Loudly, rather than passing with nothing run — a green suite that executed no
  // tests is worse than a red one.
  console.error(`No *.test.js files found in ${here}. Did the compile step run?`);
  process.exit(1);
}

for (const file of testFiles) {
  require(join(here, file));
}
