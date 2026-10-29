// Dependency vulnerability audit of the PRODUCTION dependency tree.
//   node scripts/audit.mjs            exits 1 if any advisory of severity >= --fail-on (default: high) is found
//   node scripts/audit.mjs --all      include dev dependencies too
//
// Why not `pnpm audit`? It hung on slow networks; this does the same job directly: enumerate every
// name@version in the tree (pnpm ls), ask the npm advisory API about all of them in ONE request, report.
import { execFileSync } from 'node:child_process';

const all = process.argv.includes('--all');
const failOn = (process.argv.find((a) => a.startsWith('--fail-on='))?.split('=')[1] ?? 'high').toLowerCase();
const RANK = { low: 1, moderate: 2, high: 3, critical: 4 };

const raw = execFileSync('pnpm', ['ls', '-r', all ? '--depth=Infinity' : '--prod', '--depth=Infinity', '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const packages = new Map(); // name -> Set(version)
const walk = (deps = {}) => {
  for (const [name, info] of Object.entries(deps)) {
    if (info.version && !info.version.startsWith('link:') && !name.startsWith('@zerodrift/')) {
      if (!packages.has(name)) packages.set(name, new Set());
      packages.get(name).add(info.version);
    }
    walk(info.dependencies);
  }
};
for (const project of JSON.parse(raw)) {
  walk(project.dependencies);
  if (all) walk(project.devDependencies);
}

const entries = [...packages].map(([n, v]) => [n, [...v]]);
const advisories = {};
// the API is happier with moderate request sizes than one huge body
for (let i = 0; i < entries.length; i += 100) {
  const batch = Object.fromEntries(entries.slice(i, i + 100));
  let ok = false;
  for (let attempt = 1; attempt <= 5 && !ok; attempt++) {
    try {
      const res = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        Object.assign(advisories, await res.json());
        ok = true;
      }
    } catch {
      /* retry */
    }
    if (!ok) await new Promise((r) => setTimeout(r, 1_500));
  }
  if (!ok) {
    console.error(`Could not reach the npm advisory API for packages ${i}-${i + 100}; audit INCOMPLETE`);
    process.exit(2);
  }
}
const found = [];
for (const [name, list] of Object.entries(advisories)) for (const a of list) found.push({ name, versions: [...packages.get(name)], severity: a.severity, title: a.title, range: a.vulnerable_versions, url: a.url });
found.sort((a, b) => RANK[b.severity] - RANK[a.severity]);

console.log(`Audited ${[...packages.values()].reduce((n, v) => n + v.size, 0)} package versions (${packages.size} packages), ${all ? 'including' : 'excluding'} dev dependencies.`);
if (found.length === 0) console.log('No known vulnerabilities.');
for (const f of found) console.log(`  [${f.severity.toUpperCase()}] ${f.name}@${f.versions.join(',')}  ${f.title}  (vulnerable: ${f.range})  ${f.url}`);
const blocking = found.filter((f) => RANK[f.severity] >= RANK[failOn]);
process.exit(blocking.length ? 1 : 0);
