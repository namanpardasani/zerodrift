#!/usr/bin/env node
// Proves the PRODUCTION Helm values are safe, by rendering the chart and checking the result (needs `helm` on PATH):
//   pnpm verify:prod
// It also checks that the chart REFUSES unsafe combinations (negative tests). Nothing is deployed.
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';

const CHART = 'deploy/helm/zerodrift';
const VALUES = `${CHART}/values-prod.yaml`;
const PATH_EXTRA = `${process.env.HOME}/.local/bin`;
const helm = (args) => spawnSync('helm', ['template', 'zerodrift', CHART, '-f', VALUES, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH}` } });

let failures = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `: ${detail}`}`);
  if (!ok) failures++;
};

console.log('Rendering the production values');
const out = helm(['--set', 'image.registry=registry.example/you/', '--set', 'image.tag=v1.2.3']);
if (out.status !== 0) {
  console.error(out.stderr || 'helm template failed (is helm installed? scripts/install-tools.sh)');
  process.exit(2);
}
const docs = out.stdout.split(/^---$/m).map((d) => d.trim()).filter(Boolean).map((d) => parse(d)).filter(Boolean);
const of = (kind) => docs.filter((d) => d.kind === kind);
const deployments = of('Deployment');
const names = deployments.map((d) => d.metadata.name);
const container = (d) => d.spec.template.spec.containers[0];
const envOf = (d) => Object.fromEntries((container(d).env ?? []).map((e) => [e.name, e.value ?? '(from secret)']));

check(['ledger', 'payments', 'webhook', 'reconciliation', 'mock-gateway', 'dashboard-api', 'demo-shop'].every((n) => names.includes(n)), 'all runtime services are deployed', names.join(', '));
check(!names.some((n) => ['chaos-controller', 'demo-receiver', 'toxiproxy'].includes(n)), 'no test tools are deployed (chaos-controller, demo-receiver, toxiproxy)');
check(of('Role').length === 0 && of('RoleBinding').length === 0 && of('ServiceAccount').length === 0, 'no RBAC objects (nothing may kill pods)');
check(!JSON.stringify(docs).includes('nodePort'), 'no NodePort anywhere');
check(of('Service').every((s) => (s.spec.type ?? 'ClusterIP') === 'ClusterIP'), 'every Service is ClusterIP (only the Ingress is public)');
check(deployments.every((d) => envOf(d).NODE_ENV === 'production'), 'every service runs with NODE_ENV=production (which refuses development secrets)');
check(deployments.every((d) => container(d).image.startsWith('registry.example/you/zerodrift-') && container(d).image.endsWith(':v1.2.3')), 'images come from the given registry at the given tag');
check(deployments.every((d) => d.spec.template.spec.securityContext?.runAsNonRoot === true && container(d).securityContext?.readOnlyRootFilesystem === true && container(d).securityContext?.capabilities?.drop?.includes('ALL') && container(d).securityContext?.allowPrivilegeEscalation === false), 'every container: non-root, read-only filesystem, no capabilities, no privilege escalation');
check(deployments.every((d) => container(d).readinessProbe && container(d).livenessProbe && container(d).resources?.limits?.memory), 'every container has readiness and liveness probes and a memory limit');
const multi = deployments.filter((d) => d.spec.replicas > 1).map((d) => d.metadata.name);
check(multi.every((n) => of('PodDisruptionBudget').some((p) => p.metadata.name === n)), 'every multi-replica service has a PodDisruptionBudget', multi.join(', '));
check(of('Secret').length === 0, 'the chart creates no Secret (values-prod uses an existing one, so no secret is in Git)');
check(!/dev-admin-token|dev-gateway-secret|change-me|kind-test|dev-jwt|zerodrift-dev/.test(out.stdout), 'no development or test secret appears in the rendered output');

const ing = of('Ingress')[0];
const apiRule = ing?.spec.rules.find((r) => r.host === 'api.example.com');
const apiPaths = (apiRule?.http.paths ?? []).map((p) => p.path);
check(!!ing && ing.spec.tls?.length === 1, 'an Ingress with TLS exists');
check(apiPaths.length > 0 && apiPaths.every((p) => p.startsWith('/v1')), 'the API host routes only /v1 paths', apiPaths.join(' '));
check(!apiPaths.some((p) => /admin|internal|metrics|health|ready/.test(p)), 'operator paths (/admin, /internal, /metrics) are not routed from outside');
const routedServices = new Set(ing.spec.rules.flatMap((r) => r.http.paths.map((p) => p.backend.service.name)));
check([...routedServices].every((s) => ['dashboard-api', 'demo-shop', 'payments', 'webhook'].includes(s)), 'only dashboard-api, demo-shop, payments and webhook are reachable from outside (never ledger, gateway or reconciliation)', [...routedServices].join(', '));

console.log('\nThe chart must REFUSE unsafe combinations');
const refuses = (what, args, message) => {
  const r = helm(args);
  check(r.status !== 0 && r.stderr.includes(message), what, r.status === 0 ? 'it rendered' : r.stderr.slice(0, 200));
};
refuses('chaos-controller with nodeEnv=production', ['--set', 'services.chaos-controller.enabled=true'], 'must never run in production');
refuses('dashboard-api without secrets', ['--set', 'secrets.existingSecret=', '--set', 'secrets.postgresPassword=x', '--set', 'secrets.adminToken=x', '--set', 'secrets.gatewayCallbackSecret=x', '--set', 'secrets.webhookEncryptionKey=x'], 'jwtSecret and secrets.dashboardPassword');
refuses('demo-shop without a public URL', ['--set', 'services.demo-shop.env.PUBLIC_URL='], 'PUBLIC_URL');
refuses('no secrets at all', ['--set', 'secrets.existingSecret=', '--set', 'services.dashboard-api.enabled=false', '--set', 'services.demo-shop.enabled=false'], 'is required');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll production checks passed');
process.exit(failures ? 1 : 0);
