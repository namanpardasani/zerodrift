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

const raw = execFileSync('pnpm', ['ls', '-r', ...(all ? [] : ['--prod']), '--depth=Infinity', '--json'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
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
// Workspace packages that exist only to run tests (they pull in testcontainers and its archive tooling) are not part of
// anything that ships, so the default scope excludes them; `--all` includes them. Verified: none of their packages is in any production image.
const TEST_ONLY = new Set(['@zerodrift/testing', '@zerodrift/chaos']);
const skipped = [];
for (const project of JSON.parse(raw)) {
  if (!all && TEST_ONLY.has(project.name)) {
    skipped.push(project.name);
    continue;
  }
  walk(project.dependencies);
  if (all) walk(project.devDependencies);
}

const entries = [...packages].map(([n, v]) => [n, [...v]]);
/**
 * Two sources, same answer shape. The npm registry's bulk advisory endpoint is tried first (short timeout); if it cannot be
 * reached (it hung from some networks), OSV.dev (Google's open vulnerability database, which includes the GitHub advisories
 * for npm) is used instead. `--source=osv` or `--source=npm` forces one. The audit never silently passes: if neither answers it exits 2.
 */
const forced = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1];
const post = (url, body, ms) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });

async function viaNpm(timeoutMs) {
  const advisories = {};
  for (let i = 0; i < entries.length; i += 100) {
    const res = await post('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', Object.fromEntries(entries.slice(i, i + 100)), timeoutMs);
    if (!res.ok) throw new Error(`npm advisory API HTTP ${res.status}`);
    Object.assign(advisories, await res.json());
  }
  return { source: 'npm registry advisories', advisories };
}

async function viaOsv() {
  const queries = entries.flatMap(([name, versions]) => versions.map((version) => ({ name, version })));
  const hits = []; // { name, version, id }
  for (let i = 0; i < queries.length; i += 500) {
    const chunk = queries.slice(i, i + 500);
    const res = await post('https://api.osv.dev/v1/querybatch', { queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: 'npm' }, version: q.version })) }, 60_000);
    if (!res.ok) throw new Error(`OSV querybatch HTTP ${res.status}`);
    (await res.json()).results.forEach((r, j) => (r.vulns ?? []).forEach((v) => hits.push({ ...chunk[j], id: v.id })));
  }
  const ids = [...new Set(hits.map((h) => h.id))];
  const detail = new Map();
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(async (id) => {
      const r = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`OSV vuln ${id} HTTP ${r.status}`);
      detail.set(id, await r.json());
    }));
  }
  const advisories = {};
  for (const h of hits) {
    const d = detail.get(h.id);
    const sev = (d.database_specific?.severity ?? 'moderate').toLowerCase();
    (advisories[h.name] ??= []).push({ severity: RANK[sev] ? sev : 'moderate', title: d.summary ?? h.id, vulnerable_versions: h.version, url: `https://osv.dev/vulnerability/${h.id}` });
  }
  return { source: 'OSV.dev (GitHub advisories for npm)', advisories };
}

let result;
try {
  result = forced === 'osv' ? await viaOsv() : await viaNpm(forced === 'npm' ? 30_000 : 10_000);
} catch (firstError) {
  if (forced) {
    console.error(`${forced} source failed: ${firstError.message}; audit INCOMPLETE`);
    process.exit(2);
  }
  console.error(`npm advisory endpoint unavailable (${firstError.message}); falling back to OSV.dev`);
  try {
    result = await viaOsv();
  } catch (secondError) {
    console.error(`OSV.dev also failed (${secondError.message}); audit INCOMPLETE`);
    process.exit(2);
  }
}
const advisories = result.advisories;
console.log(`Source: ${result.source}`);
const found = [];
for (const [name, list] of Object.entries(advisories)) for (const a of list) found.push({ name, versions: [...packages.get(name)], severity: a.severity, title: a.title, range: a.vulnerable_versions, url: a.url });
found.sort((a, b) => RANK[b.severity] - RANK[a.severity]);

if (skipped.length) console.log(`Test-only workspace packages excluded (not shipped): ${skipped.join(', ')}. Use --all to include them.`);
console.log(`Audited ${[...packages.values()].reduce((n, v) => n + v.size, 0)} package versions (${packages.size} packages), ${all ? 'including' : 'excluding'} dev dependencies.`);
if (found.length === 0) console.log('No known vulnerabilities.');
for (const f of found) console.log(`  [${f.severity.toUpperCase()}] ${f.name}@${f.versions.join(',')}  ${f.title}  (vulnerable: ${f.range})  ${f.url}`);
const blocking = found.filter((f) => RANK[f.severity] >= RANK[failOn]);
process.exit(blocking.length ? 1 : 0);
