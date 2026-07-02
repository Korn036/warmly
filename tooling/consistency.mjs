/* Pure-Node repo consistency guard (no browser). Catches the release-drift class that has actually
   bitten this project: sw cache not bumped with VERSION, a SHELL entry pointing at a missing file
   after the landing/app split, a broken manifest, or a placeholder assetlinks surviving past launch.
   Runs in the `selftest` CI job. Exit non-zero on any failure. */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(join(ROOT, f), 'utf8');
const results = [];
const ok = (name, pass, got) => results.push({ name, p: !!pass, got });

const appjs = read('app.js');
const swjs = read('sw.js');

/* 1. VERSION (app.js) must equal the sw.js cache suffix, so a deploy is verifiable and the SW updates */
const ver = (appjs.match(/const VERSION='([^']+)'/) || [])[1];
const cache = (swjs.match(/const CACHE\s*=\s*'sovenn-([^']+)'/) || [])[1];
ok('VERSION matches sw cache', ver && ver === cache, ver + ' vs ' + cache);

/* 2. every sw SHELL url resolves to a real file on disk (./=index.html, app=app.html, card=card.html) */
const shellM = swjs.match(/const SHELL\s*=\s*\[([^\]]+)\]/);
const shell = shellM ? shellM[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
const alias = { './': 'index.html', 'app': 'app.html', 'card': 'card.html' };
const missing = shell.filter(u => !existsSync(join(ROOT, alias[u] || u)));
ok('all sw SHELL files exist (' + shell.length + ')', missing.length === 0, missing.join(', '));

/* 3. every local <script src> in app.html is precached, so offline app boot has its code */
const apphtml = read('app.html');
const scripts = [...apphtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1])
  .filter(s => !/^https?:/i.test(s)).map(s => s.replace(/^\.\//, ''));
const shellSet = new Set(shell);
const notCached = scripts.filter(s => !shellSet.has(s));
ok('app.html local scripts are precached', notCached.length === 0, notCached.join(', '));

/* 4. manifest parses and has the fields Play/TWA needs (start_url, scope, display, 512 + maskable icon) */
let manOk = false, manWhy = '';
try {
  const m = JSON.parse(read('manifest.webmanifest'));
  const has512 = (m.icons || []).some(i => /512/.test(i.sizes || ''));
  const hasMask = (m.icons || []).some(i => /maskable/.test(i.purpose || ''));
  manOk = !!(m.start_url && m.scope && m.display && has512 && hasMask);
  manWhy = 'start_url=' + m.start_url + ' display=' + m.display + ' 512=' + has512 + ' maskable=' + hasMask;
} catch (e) { manWhy = 'parse error ' + e.message; }
ok('manifest valid (start_url/512/maskable)', manOk, manWhy);

/* 5. assetlinks parses; pre-launch the placeholder is fine, but once a .well-known/LAUNCHED flag file
      exists the fingerprint MUST be a real SHA-256 — so a placeholder can never survive launch day */
let alOk = false, alWhy = '';
try {
  const al = JSON.parse(read('.well-known/assetlinks.json'));
  const fp = (((al[0] || {}).target || {}).sha256_cert_fingerprints || [])[0] || '';
  const launched = existsSync(join(ROOT, '.well-known/LAUNCHED'));
  const isReal = /^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/i.test(fp);
  alOk = launched ? isReal : (al[0].target.package_name === 'app.sovenn.twa');
  alWhy = launched ? ('launched: fingerprint real=' + isReal) : 'pre-launch placeholder ok';
} catch (e) { alWhy = 'parse error ' + e.message; }
ok('assetlinks valid', alOk, alWhy);

let pass = 0, fail = 0;
for (const x of results) { const s = x.p ? 'PASS' : 'FAIL'; if (x.p) pass++; else fail++; console.log(`${s}  ${x.name}${x.p ? '' : '   -> ' + x.got}`); }
console.log(`\n${pass}/${pass + fail} passed, ${fail} failing`);
process.exit(fail ? 1 : 0);
