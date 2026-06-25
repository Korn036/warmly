// Runs each Sovenn on-device module's pure-logic _selftest() under Node (no
// browser needed). The modules are IIFEs that attach window.Sovenn* via a
// `G = window || globalThis` shim, so under Node they attach to globalThis.
// Exit non-zero on any failure so CI blocks a broken module.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
  ['shuffle.js', 'SovennShuffle'],
  ['memory.js', 'SovennMemory'],
  ['streak.js', 'SovennStreak'],
  ['capture.js', 'SovennCapture'],
  ['enrich.js', 'SovennEnrich'],
  ['notify.js', 'SovennNotify'],
  ['ai.js', 'SovennAI'],
];

let failures = 0;
let totalChecks = 0;

// Load every module into the shared global (their IIFE assigns G.SovennX).
for (const [file] of MODULES) {
  const code = fs.readFileSync(path.join(root, file), 'utf8');
  try {
    vm.runInThisContext(code, { filename: file });
  } catch (e) {
    console.error(`LOAD FAIL ${file}: ${e.message}`);
    failures++;
  }
}

for (const [file, ns] of MODULES) {
  const mod = globalThis[ns];
  if (!mod || typeof mod._selftest !== 'function') {
    console.error(`FAIL ${ns} (${file}): no _selftest()`);
    failures++;
    continue;
  }
  let r;
  try {
    r = mod._selftest();
  } catch (e) {
    console.error(`FAIL ${ns} (${file}): _selftest threw ${e.message}`);
    failures++;
    continue;
  }
  const results = (r && r.results) || [];
  const bad = results.filter((x) => !x.pass);
  totalChecks += results.length;
  if (!r || !r.pass || bad.length) {
    console.error(`FAIL ${ns} (${file}): ${bad.map((b) => b.name).join(', ') || 'no results'}`);
    failures++;
  } else {
    console.log(`PASS ${ns} (${results.length} checks)`);
  }
}

console.log(`\n${totalChecks} assertions across ${MODULES.length} modules; ${failures} failing`);
process.exit(failures ? 1 : 0);
