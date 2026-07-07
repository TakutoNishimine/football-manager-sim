/**
 * Plain-JavaScript bootstrap for league worker_threads (Task AK).
 *
 * Getting a Worker to load a `.ts` entry point (and its extensionless
 * `.ts` imports, e.g. `src/sim/world.ts`'s `from './constants'`) turned out
 * to be Node-version/platform sensitive: relying on Node inheriting tsx's
 * loader flags via `process.execArgv`, or even hard-coding
 * `execArgv: ['--import', 'tsx']` on the Worker, both worked on macOS/Node
 * 24 locally but threw `Cannot find module '.../src/sim/constants'` inside
 * the worker on the Linux/Node 22 GitHub Actions runner.
 *
 * The robust fix is tsx's own documented in-process Node.js API instead of
 * CLI-flag propagation: this file is deliberately plain `.mjs` (needs no
 * loader to parse itself), registers tsx's TypeScript loader by calling the
 * API directly, THEN dynamically imports the real (TypeScript) worker
 * module named by the `LEAGUE_WORKER_ENTRY` env var (set per-Worker in
 * pool.ts). Because this happens inside the worker thread's own module
 * bootstrap rather than via inherited CLI flags, it's independent of how —
 * or on what Node build — the parent process was started.
 */
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const entry = process.env.LEAGUE_WORKER_ENTRY;
if (!entry) {
  throw new Error('worker-bootstrap.mjs requires the LEAGUE_WORKER_ENTRY env var (absolute path to the .ts worker module)');
}

await tsImport(pathToFileURL(entry).href, import.meta.url);
