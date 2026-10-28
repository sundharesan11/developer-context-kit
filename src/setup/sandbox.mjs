// U9 (R11): agent sandbox and container recommendations for one project, from its onboarding scan. This module writes
// no agent setting. The plan only reads; apply stores the recommendations the owner accepts as personal preference
// records (so a later setup review can list them). Env example files are read only when the source reader allows
// them, and only their key names are kept, never a value.
import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { readApprovedSource, isDeniedRel } from "../storage/source-read.mjs";
import { scanRepository } from "../onboarding/scan.mjs";
import { readPersonalSnapshot, addPersonalRecord } from "../records/personal.mjs";

const COMPOSE = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const CONTAINER = ["Dockerfile", "Containerfile", ".devcontainer"];
const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template", "env.example", "example.env"];
// Service names from image names, package names and env key names. Each rule is [pattern, service].
const IMAGE_RULES = [[/^(?:postgres|postgis\/postgis)/, "postgres"], [/^(?:mysql|mariadb)/, "mysql"], [/^mongo/, "mongodb"], [/^(?:redis|valkey)/, "redis"], [/^rabbitmq/, "rabbitmq"], [/kafka/, "kafka"], [/elasticsearch|opensearch/, "search"], [/^(?:minio|localstack)/, "object-storage"]];
const PACKAGE_RULES = [[/^(?:pg|postgres|pg-promise)$/, "postgres"], [/^(?:mysql|mysql2|mariadb)$/, "mysql"], [/^(?:mongodb|mongoose)$/, "mongodb"], [/^(?:redis|ioredis)$/, "redis"], [/^(?:amqplib)$/, "rabbitmq"], [/^(?:kafkajs)$/, "kafka"], [/^(?:prisma|@prisma\/client|sequelize|typeorm|knex|drizzle-orm)$/, "database"]];
const ENV_RULES = [[/^(?:DATABASE_URL|DB_URL|DB_HOST|POSTGRES_\w+|PG\w+)$/, "database"], [/^MYSQL_\w+$/, "mysql"], [/^MONGO\w*$/, "mongodb"], [/^REDIS_\w+$/, "redis"], [/^(?:AMQP_URL|RABBITMQ_\w+)$/, "rabbitmq"], [/^KAFKA_\w+$/, "kafka"]];
const PY_RULES = [[/psycopg|asyncpg/, "postgres"], [/pymysql|mysqlclient/, "mysql"], [/pymongo/, "mongodb"], [/\bredis\b/, "redis"], [/sqlalchemy/, "database"]];
const GO_RULES = [[/jackc\/pgx|lib\/pq/, "postgres"], [/go-sql-driver\/mysql/, "mysql"], [/mongo-driver/, "mongodb"], [/go-redis|redis\/go-redis/, "redis"]];
const matchRules = (rules, text) => rules.filter(([pattern]) => pattern.test(text)).map(([, service]) => service);

function composeServices(text) {
  const services = [];
  for (const m of text.matchAll(/^\s+image:\s*["']?([^\s"'#]+)/gm)) services.push(...matchRules(IMAGE_RULES, m[1].toLowerCase().replace(/^docker\.io\/(?:library\/)?/, "")));
  return services;
}
function packageServices(text) {
  try {
    const pkg = JSON.parse(text), names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    return names.flatMap((name) => matchRules(PACKAGE_RULES, name));
  } catch { return []; }
}
// Key names only: everything after the first "=" is dropped before any rule sees the line.
const envServices = (text) => text.split(/\r?\n/).map((line) => line.replace(/^\s*export\s+/, "").split("=")[0].trim()).filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key)).flatMap((key) => matchRules(ENV_RULES, key));

export async function scanSignals(pilot, repo) {
  if (typeof repo !== "string") throw new DevtwinError("INVALID_INPUT", "Repository required", { field: "repo" });
  assertInPilot(pilot, repo, "repos");
  const scan = await scanRepository({ repo });
  const top = new Set(scan.topLevel), root = scan.location.root, files = [], services = [], unread = [];
  const byRel = new Map(scan.sources.filter((s) => !s.skipped).map((s) => [s.rel, s.text]));
  for (const rel of [...COMPOSE, ...CONTAINER, ...ENV_EXAMPLES].filter((name) => top.has(name))) files.push(rel);
  for (const rel of files.filter((name) => COMPOSE.includes(name) || ENV_EXAMPLES.includes(name))) {
    const source = isDeniedRel(rel) ? { skipped: "denied" } : await readApprovedSource(root, rel);
    if (source.skipped) { unread.push({ file: rel, reason: source.skipped }); continue; }
    services.push(...(COMPOSE.includes(rel) ? composeServices(source.text) : envServices(source.text)));
  }
  if (byRel.has("package.json")) services.push(...packageServices(byRel.get("package.json")));
  if (byRel.has("pyproject.toml")) services.push(...matchRules(PY_RULES, byRel.get("pyproject.toml").toLowerCase()));
  if (byRel.has("go.mod")) services.push(...matchRules(GO_RULES, byRel.get("go.mod")));
  return { files, services: [...new Set(services)].sort(), unread };
}

export function recommend(signals) {
  const compose = signals.files.find((f) => COMPOSE.includes(f)), image = signals.files.find((f) => CONTAINER.includes(f));
  const envs = signals.files.filter((f) => ENV_EXAMPLES.includes(f)), named = signals.services.filter((s) => s !== "database");
  const serviceText = named.length ? named.join(", ") : "a database";
  const recs = [
    { id: "claude-sandbox", agent: "claude", title: "Claude Code sandbox", text: "Claude Code: turn on the sandbox for shell commands (/sandbox) and keep the permission prompts for edits and shell commands. Do not allow commands without a prompt in this project." },
    { id: "codex-sandbox", agent: "codex", title: "Codex sandbox", text: "Codex: run with --sandbox workspace-write and --ask-for-approval on-request. Use --sandbox read-only when you only read the project." + (signals.services.length ? " Network access stays off in workspace-write; turn it on only for this project and only if the agent must reach the local services." : "") }
  ];
  if (compose || image || signals.services.length) {
    const how = compose ? "Run the services (" + serviceText + ") with docker compose from " + compose + "."
      : image ? "Run the build and the tests in the container from " + image + "."
      : "This project uses " + serviceText + ". Run it in a local container, with docker compose or a dev container.";
    recs.push({ id: "container", agent: null, title: "Container setup", text: how + " Point the agent at those local containers, never at a shared or production service." });
  }
  if (envs.length) recs.push({ id: "env-files", agent: null, title: "Env files", text: "Keep real env files out of the agent's reach. Give the agent only the example file (" + envs.join(", ") + "), and deny reads of .env files in the agent's permission settings." });
  return recs;
}

const repoKey = (repo) => createHash("sha256").update(repo).digest("hex").slice(0, 12);
// U21: the setup review reads these request IDs to compare the saved settings with a new scan.
export const sandboxRequestFor = (repo, id) => "req_setup_sandbox_" + id + "_" + repoKey(repo);
const requestFor = sandboxRequestFor;
const RUN = "run_setup_sandbox";
export async function planSandbox(ctx) {
  const repo = ctx.values.repo, signals = await scanSignals(ctx.pilot, repo), recommendations = recommend(signals);
  const chosen = ctx.values.recommendation === undefined ? [] : [].concat(ctx.values.recommendation);
  if (chosen.some((id) => !recommendations.some((r) => r.id === id))) throw new DevtwinError("INVALID_INPUT", "Unknown sandbox recommendation", { field: "recommendation" });
  const existing = new Set((await readPersonalSnapshot(ctx.roots)).records.map((r) => r.requestId));
  const records = recommendations.filter((r) => !chosen.length || chosen.includes(r.id)).map((r) => ({ recommendation: r.id, requestId: requestFor(repo, r.id), title: "Sandbox: " + r.title, body: r.text + "\n", exists: existing.has(requestFor(repo, r.id)) }));
  return finalizePlan({ kind: "setup-sandbox", repo, signals, recommendations, writesAgentSettings: false, destination: { root: "dataRoot", path: "personal/records" }, records });
}
export async function applySandbox(ctx, fingerprint) {
  const plan = await planSandbox(ctx);
  assertFingerprint(plan, fingerprint);
  const results = [];
  for (const r of plan.records) {
    const draft = { kind: "preference", status: "observed", title: r.title, body: r.body, reach: "personal", tags: ["sandbox"] };
    results.push({ recommendation: r.recommendation, ...(await addPersonalRecord(ctx.roots, { requestId: r.requestId, recordedBy: { actor: "human", runId: RUN }, draft }, { now: ctx.now })) });
  }
  return { applied: true, writesAgentSettings: false, records: results };
}
export async function sandboxDone(ctx) {
  const prefix = "req_setup_sandbox_", key = typeof ctx.values.repo === "string" ? "_" + repoKey(ctx.values.repo) : null;
  return (await readPersonalSnapshot(ctx.roots)).records.some((r) => r.requestId.startsWith(prefix) && (key === null || r.requestId.endsWith(key)));
}
