import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const port = Number(process.env.PORT || 4173);
const root = process.cwd();
const dataDir = join(root, "data");
const storageDir = process.env.STORAGE_DIR ? normalize(process.env.STORAGE_DIR) : dataDir;
const tasksFile = join(dataDir, "tasks.json");
const runsFile = join(storageDir, "runs.json");
const legacyRunsFile = join(dataDir, "runs.json");
const dbFile = join(storageDir, "arena.sqlite");
const publicBaseUrl = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "";
const configuredExamTaskCount = Number(process.env.EXAM_TASK_COUNT || 60);
const defaultExamTaskCount = Number.isFinite(configuredExamTaskCount) && configuredExamTaskCount > 0 ? Math.floor(configuredExamTaskCount) : 60;
const sqliteMaxBuffer = 64 * 1024 * 1024;
const stalledLowProgressMs = 10 * 60 * 1000;
const lowProgressSubmissionLimit = 3;

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
};

function ensureDataStore() {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(storageDir, { recursive: true });
  dbExec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      data_scope TEXT NOT NULL DEFAULT 'real',
      is_demo INTEGER NOT NULL DEFAULT 0,
      seed TEXT
    );
    CREATE TABLE IF NOT EXISTS answers (
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      answer_json TEXT,
      correct INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 0,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (run_id, task_id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at);
    CREATE INDEX IF NOT EXISTS idx_answers_task_id ON answers(task_id);
    CREATE TABLE IF NOT EXISTS run_tasks (
      run_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (run_id, position),
      UNIQUE (run_id, task_id),
      FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_run_tasks_run_id ON run_tasks(run_id);
  `);
  ensureColumn("runs", "seed", "TEXT");
  migrateRunsJsonToDb();
}

function loadTasks() {
  if (!existsSync(tasksFile)) {
    throw new Error(`Missing task file: ${tasksFile}`);
  }

  const parsed = JSON.parse(readFileSync(tasksFile, "utf8"));
  const tasks = Array.isArray(parsed) ? parsed : parsed.tasks;

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("data/tasks.json must contain a non-empty tasks array.");
  }

  const ids = new Set();
  for (const task of tasks) {
    if (!task.id || ids.has(task.id)) {
      throw new Error(`Task ids must be present and unique. Problem id: ${task.id}`);
    }
    ids.add(task.id);
  }

  return tasks;
}

function hashSeed(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createPrng(seed) {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state = Math.imul(state + 0x6d2b79f5, 1);
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, random = Math.random) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function groupBy(tasks, keyFn) {
  const buckets = new Map();
  for (const task of tasks) {
    const key = String(keyFn(task) ?? "unknown");
    if (!buckets.has(key)) {
      buckets.set(key, { key, tasks: [] });
    }
    buckets.get(key).tasks.push(task);
  }
  return [...buckets.values()];
}

function allocateQuota(groups, targetCount, totalTasks) {
  const allocations = groups.map((group) => {
    const raw = (group.tasks.length / totalTasks) * targetCount;
    return {
      ...group,
      count: Math.floor(raw),
      remainder: raw - Math.floor(raw),
    };
  });

  let assigned = allocations.reduce((total, group) => total + group.count, 0);
  const byRemainder = [...allocations].sort((left, right) => right.remainder - left.remainder || right.tasks.length - left.tasks.length);

  for (const group of byRemainder) {
    if (assigned >= targetCount) break;
    if (group.count >= group.tasks.length) continue;
    group.count += 1;
    assigned += 1;
  }

  return allocations;
}

function quotaMap(tasks, targetCount, keyFn) {
  return new Map(allocateQuota(groupBy(tasks, keyFn), targetCount, tasks.length).map((group) => [String(group.key), group.count]));
}

function difficultyBucket(task) {
  const score = Number(task.difficulty_score);
  if (score <= 4) return "b1";
  if (score <= 6) return "b2";
  if (score <= 10) return "b3";
  if (score === 12) return "b4";
  if (score === 15) return "b5";
  return "other";
}

function taskDomain(task) {
  const module = String(task.module || "");
  if (module === "通用能力") return "通用";
  if (module.includes("客服")) return "客服";
  if (module.includes("选品")) return "选品";
  if (module.includes("数据")) return "数据";
  if (module.includes("产品")) return "产运";
  if (module.includes("投资分析")) return "金分";
  if (module.includes("投资审查")) return "金审";
  return module || "unknown";
}

function taskCategory(task) {
  return task.category || task.track || "unknown";
}

const v6BucketQuota = new Map([
  ["b1", 12],
  ["b2", 12],
  ["b3", 12],
  ["b4", 12],
  ["b5", 12],
]);

const v6DomainQuota = new Map([
  ["通用", 18],
  ["客服", 7],
  ["选品", 7],
  ["数据", 7],
  ["产运", 7],
  ["金分", 7],
  ["金审", 7],
]);

function sampleV6ExamTasks(tasks, seed) {
  const random = createPrng(seed);
  const selected = [];
  const selectedIds = new Set();
  const domainCounts = new Map([...v6DomainQuota.keys()].map((domain) => [domain, 0]));
  const categoryCounts = new Map();
  const pools = groupBy(tasks, difficultyBucket)
    .filter((bucket) => v6BucketQuota.has(bucket.key))
    .sort((left, right) => left.tasks.length - right.tasks.length || left.key.localeCompare(right.key));

  function canPick(task, { enforceDomain, enforceCategory }) {
    if (selectedIds.has(task.id)) return false;
    if (enforceDomain && (domainCounts.get(taskDomain(task)) || 0) >= (v6DomainQuota.get(taskDomain(task)) || 0)) return false;
    if (enforceCategory && (categoryCounts.get(taskCategory(task)) || 0) >= 2) return false;
    return true;
  }

  function pick(task) {
    selected.push(task);
    selectedIds.add(task.id);
    domainCounts.set(taskDomain(task), (domainCounts.get(taskDomain(task)) || 0) + 1);
    categoryCounts.set(taskCategory(task), (categoryCounts.get(taskCategory(task)) || 0) + 1);
  }

  for (const bucket of pools) {
    const target = v6BucketQuota.get(bucket.key);
    let pickedInBucket = 0;
    const candidates = shuffle(bucket.tasks, random);
    const rounds = [
      { enforceDomain: true, enforceCategory: true },
      { enforceDomain: false, enforceCategory: true },
      { enforceDomain: false, enforceCategory: false },
    ];

    for (const round of rounds) {
      if (pickedInBucket >= target) break;
      for (const task of candidates) {
        if (pickedInBucket >= target) break;
        if (!canPick(task, round)) continue;
        pick(task);
        pickedInBucket += 1;
      }
    }
  }

  if (selected.length !== 60) {
    throw new Error(`V6 sampler expected 60 tasks but selected ${selected.length}.`);
  }

  return selected;
}

function sampleLegacyExamTasks(tasks, count, seed) {
  const random = createPrng(seed);
  const groups = groupBy(tasks, (task) => `${task.type || "unknown"}::${task.difficulty || "unknown"}`);
  const allocations = allocateQuota(groups, count, tasks.length);
  const selected = [];

  for (const group of allocations) {
    selected.push(...shuffle(group.tasks, random).slice(0, group.count));
  }

  if (selected.length < count) {
    const selectedIds = new Set(selected.map((task) => task.id));
    const remaining = shuffle(tasks.filter((task) => !selectedIds.has(task.id)), random);
    selected.push(...remaining.slice(0, count - selected.length));
  }

  return shuffle(selected, random).slice(0, count);
}

function sampleExamTasks(tasks, requestedCount = defaultExamTaskCount, seed = randomUUID()) {
  const count = Math.max(1, Math.min(Number(requestedCount) || defaultExamTaskCount, tasks.length));
  const hasV6Difficulty = tasks.every((task) => task.module && task.difficulty_score && task.cognitive_depth && task.format_complexity);
  return hasV6Difficulty && count === 60 ? sampleV6ExamTasks(tasks, seed) : sampleLegacyExamTasks(tasks, count, seed);
}

function tasksForRun(run, allTasks) {
  if (!run?.task_ids?.length) {
    return allTasks;
  }

  const byId = new Map(allTasks.map((task) => [task.id, task]));
  return run.task_ids.map((taskId) => byId.get(taskId)).filter(Boolean);
}

function sqlString(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "0";
}

function dbExec(sql) {
  execFileSync("sqlite3", [dbFile, sql], { encoding: "utf8", maxBuffer: sqliteMaxBuffer });
}

function dbQuery(sql) {
  const output = execFileSync("sqlite3", ["-json", dbFile, sql], { encoding: "utf8", maxBuffer: sqliteMaxBuffer }).trim();
  return output ? JSON.parse(output) : [];
}

function ensureColumn(table, column, definition) {
  const columns = dbQuery(`PRAGMA table_info(${table});`);
  if (columns.some((item) => item.name === column)) {
    return;
  }
  dbExec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function rowToRun(row) {
  return {
    id: row.id,
    agent_name: row.agent_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    data_scope: row.data_scope,
    is_demo: Boolean(row.is_demo),
    seed: row.seed || "",
    answers: {},
    task_ids: [],
  };
}

function rowToAnswer(row) {
  let answer = null;
  if (row.answer_json !== null && row.answer_json !== undefined) {
    try {
      answer = JSON.parse(row.answer_json);
    } catch {
      answer = row.answer_json;
    }
  }
  return {
    task_id: row.task_id,
    answer,
    correct: Boolean(row.correct),
    score: Number(row.score) || 0,
    submitted_at: row.submitted_at,
  };
}

function readAllRuns() {
  const runs = {};
  const runRows = dbQuery("SELECT id, agent_name, created_at, updated_at, data_scope, is_demo, seed FROM runs;");
  const answerRows = dbQuery("SELECT run_id, task_id, answer_json, correct, score, submitted_at FROM answers;");
  const taskRows = dbQuery("SELECT run_id, task_id, position FROM run_tasks ORDER BY run_id, position;");

  for (const row of runRows) {
    runs[row.id] = rowToRun(row);
  }

  for (const row of taskRows) {
    if (runs[row.run_id]) {
      runs[row.run_id].task_ids.push(row.task_id);
    }
  }

  for (const row of answerRows) {
    if (runs[row.run_id]) {
      runs[row.run_id].answers[row.task_id] = rowToAnswer(row);
    }
  }

  return { runs };
}

function readRun(runId) {
  const rows = dbQuery(`
    SELECT id, agent_name, created_at, updated_at, data_scope, is_demo, seed
    FROM runs
    WHERE id = ${sqlString(runId)}
    LIMIT 1;
  `);
  if (!rows.length) {
    return null;
  }

  const run = rowToRun(rows[0]);
  const taskRows = dbQuery(`
    SELECT run_id, task_id, position
    FROM run_tasks
    WHERE run_id = ${sqlString(runId)}
    ORDER BY position;
  `);
  run.task_ids = taskRows.map((row) => row.task_id);

  const answers = dbQuery(`
    SELECT run_id, task_id, answer_json, correct, score, submitted_at
    FROM answers
    WHERE run_id = ${sqlString(runId)};
  `);
  for (const row of answers) {
    run.answers[row.task_id] = rowToAnswer(row);
  }
  return run;
}

function createRun(run) {
  const statements = [`
    BEGIN IMMEDIATE;
    INSERT INTO runs (id, agent_name, created_at, updated_at, data_scope, is_demo, seed)
    VALUES (
      ${sqlString(run.id)},
      ${sqlString(run.agent_name)},
      ${sqlString(run.created_at)},
      ${sqlString(run.updated_at)},
      ${sqlString(run.data_scope)},
      ${run.is_demo ? 1 : 0},
      ${sqlString(run.seed || "")}
    );
  `];

  (run.task_ids || []).forEach((taskId, index) => {
    statements.push(`
      INSERT INTO run_tasks (run_id, task_id, position)
      VALUES (${sqlString(run.id)}, ${sqlString(taskId)}, ${index + 1});
    `);
  });

  statements.push("COMMIT;");
  dbExec(statements.join("\n"));
}

function upsertAnswer(runId, taskId, answer, graded, submittedAt) {
  dbExec(`
    BEGIN IMMEDIATE;
    INSERT INTO answers (run_id, task_id, answer_json, correct, score, submitted_at)
    VALUES (
      ${sqlString(runId)},
      ${sqlString(taskId)},
      ${sqlString(JSON.stringify(answer))},
      ${graded.correct ? 1 : 0},
      ${sqlNumber(graded.score)},
      ${sqlString(submittedAt)}
    )
    ON CONFLICT(run_id, task_id) DO UPDATE SET
      answer_json = excluded.answer_json,
      correct = excluded.correct,
      score = excluded.score,
      submitted_at = excluded.submitted_at;
    UPDATE runs SET updated_at = ${sqlString(submittedAt)} WHERE id = ${sqlString(runId)};
    COMMIT;
  `);
}

function migrateRunsJsonToDb() {
  const sourceRunsFile = existsSync(runsFile) ? runsFile : legacyRunsFile;
  if (!existsSync(sourceRunsFile)) {
    return;
  }

  const existing = dbQuery("SELECT COUNT(*) AS count FROM runs;");
  if ((existing[0]?.count || 0) > 0) {
    return;
  }

  const parsed = JSON.parse(readFileSync(sourceRunsFile, "utf8"));
  const legacyRuns = Object.values(parsed.runs || {});
  if (!legacyRuns.length) {
    return;
  }

  const statements = ["BEGIN IMMEDIATE;"];
  for (const run of legacyRuns) {
    const demo = isDemoRun(run);
    statements.push(`
      INSERT OR IGNORE INTO runs (id, agent_name, created_at, updated_at, data_scope, is_demo, seed)
      VALUES (
        ${sqlString(run.id)},
        ${sqlString(run.agent_name || "anonymous-agent")},
        ${sqlString(run.created_at)},
        ${sqlString(run.updated_at || run.created_at)},
        ${sqlString(demo ? "demo" : "real")},
        ${demo ? 1 : 0},
        ${sqlString(run.seed || "")}
      );
    `);
    for (const answer of Object.values(run.answers || {})) {
      statements.push(`
        INSERT OR REPLACE INTO answers (run_id, task_id, answer_json, correct, score, submitted_at)
        VALUES (
          ${sqlString(run.id)},
          ${sqlString(answer.task_id)},
          ${sqlString(JSON.stringify(answer.answer))},
          ${answer.correct ? 1 : 0},
          ${sqlNumber(answer.score)},
          ${sqlString(answer.submitted_at || run.updated_at || run.created_at)}
        );
      `);
    }
  }
  statements.push("COMMIT;");
  dbExec(statements.join("\n"));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, status, text) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(text);
}

function sendPython(response, status, text) {
  response.writeHead(status, { "content-type": "text/x-python; charset=utf-8" });
  response.end(text);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function publicTask(task) {
  const { grader, explanation, ...safeTask } = task;
  return safeTask;
}

function normalizeAnswer(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeAnswer(item)).sort();
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((next, key) => {
        next[key] = normalizeAnswer(value[key]);
        return next;
      }, {});
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return value;
}

function deepEqual(left, right) {
  return JSON.stringify(normalizeAnswer(left)) === JSON.stringify(normalizeAnswer(right));
}

function parseFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const number = Number(value.trim().replace(/%$/, ""));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function parsePercentage(value) {
  if (typeof value === "number") {
    return Math.abs(value) > 1 ? value / 100 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const isPercent = trimmed.endsWith("%");
    const number = Number(trimmed.replace(/%$/, ""));
    if (!Number.isFinite(number)) {
      return null;
    }
    return isPercent || Math.abs(number) > 1 ? number / 100 : number;
  }
  return null;
}

function withinTolerance(actual, expected, tolerance) {
  return actual !== null && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
}

function matchesExpectedValue(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "exact") {
    return deepEqual(actual, expected.value);
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "enum_set") {
    const acceptable = Array.isArray(expected.acceptable_values) ? expected.acceptable_values : [];
    return [expected.normalized_value, ...acceptable].some((candidate) => deepEqual(actual, candidate));
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "string") {
    const acceptable = Array.isArray(expected.acceptable_values) ? expected.acceptable_values : [];
    return [expected.normalized_value, ...acceptable].some((candidate) => deepEqual(actual, candidate));
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "boolean") {
    if (typeof actual === "boolean") {
      return actual === expected.normalized_value;
    }
    const normalized = String(actual).trim().toLowerCase();
    if (normalized === "true" || normalized === "false") {
      return (normalized === "true") === expected.normalized_value;
    }
    return deepEqual(actual, expected.normalized_value);
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "percentage") {
    return withinTolerance(parsePercentage(actual), Number(expected.normalized_value), Number(expected.tolerance ?? 0));
  }
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "number") {
    return withinTolerance(parseFiniteNumber(actual), Number(expected.normalized_value), Number(expected.tolerance ?? 0));
  }
  return deepEqual(actual, expected);
}

function normalizeLenientText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[，。、“”‘’：:；;,.!?！？（）()[\]{}《》<>／/\\|_\-\s]/g, "");
}

function lcsLength(left, right) {
  const previous = new Array(right.length + 1).fill(0);
  const current = new Array(right.length + 1).fill(0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? previous[rightIndex - 1] + 1
          : Math.max(previous[rightIndex], current[rightIndex - 1]);
    }
    previous.splice(0, previous.length, ...current);
    current.fill(0);
  }

  return previous[right.length];
}

function lenientStringMatch(actual, expected) {
  const expectedText = normalizeLenientText(expected);
  const actualText = normalizeLenientText(actual);

  if (!expectedText || !actualText) return false;
  if (expectedText === actualText) return true;
  if (expectedText.length <= 4) return false;
  if (expectedText.includes(actualText) || actualText.includes(expectedText)) return Math.min(expectedText.length, actualText.length) >= 4;

  const lcs = lcsLength(expectedText, actualText);
  const minLength = Math.min(expectedText.length, actualText.length);
  const maxLength = Math.max(expectedText.length, actualText.length);
  const expectedChars = new Set([...expectedText]);
  const actualChars = new Set([...actualText]);
  const commonChars = [...expectedChars].filter((char) => actualChars.has(char)).length;

  return (lcs / minLength >= 0.72 && lcs / maxLength >= 0.48) || (expectedText.length >= 8 && commonChars / expectedChars.size >= 0.72);
}

function matchesExpectedValueLenient(actual, expected) {
  if (matchesExpectedValue(actual, expected)) return true;
  if (expected && typeof expected === "object" && !Array.isArray(expected) && expected.type === "string") {
    const acceptable = Array.isArray(expected.acceptable_values) ? expected.acceptable_values : [];
    return [expected.normalized_value, ...acceptable].some((candidate) => lenientStringMatch(actual, candidate));
  }
  return false;
}

function gradeJsonFields(grader, answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return false;
  }

  for (const [field, expected] of Object.entries(grader.required_fields || {})) {
    if (!Object.hasOwn(answer, field) || !matchesExpectedValue(answer[field], expected)) {
      return false;
    }
  }

  for (const [field, rule] of Object.entries(grader.semantic_fields || {})) {
    const value = String(answer[field] ?? "").toLowerCase();
    const candidates = rule.must_include_any || [];
    if (candidates.length && !candidates.some((candidate) => value.includes(String(candidate).toLowerCase()))) {
      return false;
    }
  }

  return true;
}

function gradeJsonFieldsLenient(grader, answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return false;
  }

  for (const [field, expected] of Object.entries(grader.required_fields || {})) {
    if (!Object.hasOwn(answer, field) || !matchesExpectedValueLenient(answer[field], expected)) {
      return false;
    }
  }

  for (const [field, rule] of Object.entries(grader.semantic_fields || {})) {
    const value = String(answer[field] ?? "").toLowerCase();
    const groups = rule.keywords_all || [];
    const ok = groups.every((group) => group.some((keyword) => value.includes(String(keyword).toLowerCase())));
    if (!ok) return false;
  }

  return true;
}

function stringFieldRiskLevel(spec) {
  if (!spec || spec.type !== "string") return "safe";
  if (Object.hasOwn(spec, "acceptable_values")) return "low";
  const normalizedValue = String(spec.normalized_value ?? "");
  if (normalizedValue.length <= 4) return "low";
  if (normalizedValue.length <= 8) return "medium";
  return "high";
}

function buildStringFieldRiskReport(tasks) {
  const counts = { safe: 0, low: 0, medium: 0, high: 0 };
  const fields = [];
  const highTaskIds = new Set();

  for (const task of tasks) {
    for (const [field, spec] of Object.entries(task.grader?.required_fields || {})) {
      const risk = stringFieldRiskLevel(spec);
      counts[risk] = (counts[risk] || 0) + 1;
      if (risk === "safe") continue;
      if (risk === "high") highTaskIds.add(task.id);
      fields.push({
        task_id: task.id,
        module: task.module || "",
        category: taskCategory(task),
        category_path: task.category_path || "",
        type: task.type || "",
        difficulty_score: task.difficulty_score ?? null,
        field,
        risk,
        normalized_value: String(spec.normalized_value ?? ""),
        value_length: String(spec.normalized_value ?? "").length,
        has_acceptable_values: Object.hasOwn(spec, "acceptable_values"),
      });
    }
  }

  return {
    counts,
    string_fields: fields.length,
    high_risk_tasks: highTaskIds.size,
    fields: fields.sort(
      (left, right) =>
        ({ high: 3, medium: 2, low: 1 }[right.risk] || 0) - ({ high: 3, medium: 2, low: 1 }[left.risk] || 0) ||
        right.value_length - left.value_length ||
        left.task_id.localeCompare(right.task_id),
    ),
  };
}

function collectLenientFieldDiffs(task, answer) {
  const diffs = [];
  if (task.grader?.type !== "json_fields" || !answer || typeof answer !== "object" || Array.isArray(answer)) {
    return diffs;
  }

  for (const [field, spec] of Object.entries(task.grader.required_fields || {})) {
    if (spec?.type !== "string" || !Object.hasOwn(answer, field)) continue;
    const actual = answer[field];
    if (matchesExpectedValue(actual, spec)) continue;
    if (!matchesExpectedValueLenient(actual, spec)) continue;
    diffs.push({
      field,
      normalized_value: String(spec.normalized_value ?? ""),
      got: String(actual ?? ""),
      risk: stringFieldRiskLevel(spec),
      value_length: String(spec.normalized_value ?? "").length,
    });
  }

  return diffs;
}

function buildLiteralOnlyCandidates(runs, tasks) {
  const byTaskId = new Map(tasks.map((task) => [task.id, task]));
  const candidates = [];
  const aggregate = new Map();

  for (const run of runs) {
    for (const answer of Object.values(run.answers || {})) {
      const task = byTaskId.get(answer.task_id);
      if (!task || answer.correct) continue;
      const lenient = gradeAnswerLenient(task, answer.answer);
      if (!lenient.correct) continue;
      const diffs = collectLenientFieldDiffs(task, answer.answer);
      if (!diffs.length) continue;

      candidates.push({
        run_id: run.id,
        agent_name: run.agent_name,
        task_id: task.id,
        module: task.module || "",
        category: taskCategory(task),
        category_path: task.category_path || "",
        type: task.type || "",
        difficulty_score: task.difficulty_score ?? null,
        fields: diffs,
      });

      for (const diff of diffs) {
        const key = `${task.id}::${diff.field}::${diff.got}`;
        if (!aggregate.has(key)) {
          aggregate.set(key, {
            task_id: task.id,
            module: task.module || "",
            category: taskCategory(task),
            category_path: task.category_path || "",
            field: diff.field,
            normalized_value: diff.normalized_value,
            got: diff.got,
            risk: diff.risk,
            count: 0,
          });
        }
        aggregate.get(key).count += 1;
      }
    }
  }

  return {
    total: candidates.length,
    candidates: candidates.slice(0, 80),
    by_value: [...aggregate.values()].sort((left, right) => right.count - left.count || left.task_id.localeCompare(right.task_id)).slice(0, 120),
  };
}

function gradeAnswer(task, answer) {
  const grader = task.grader || {};

  if (grader.type === "numeric_tolerance") {
    const correct = withinTolerance(parseFiniteNumber(answer), Number(grader.value), Number(grader.tolerance ?? 0));
    return { correct, score: correct ? 1 : 0 };
  }

  if (grader.type === "percentage_tolerance") {
    const correct = withinTolerance(parsePercentage(answer), Number(grader.value), Number(grader.tolerance ?? 0));
    return { correct, score: correct ? 1 : 0 };
  }

  if (grader.type === "number_range") {
    const value = Number(answer);
    const correct = Number.isFinite(value) && value >= grader.min && value <= grader.max;
    return { correct, score: correct ? 1 : 0 };
  }

  if (grader.type === "contains_all") {
    const text = String(answer || "").toLowerCase();
    const correct = (grader.must_include || []).every((needle) => text.includes(String(needle).toLowerCase()));
    return { correct, score: correct ? 1 : 0 };
  }

  if (grader.type === "json_match" || grader.type === "exact_match") {
    const correct = deepEqual(answer, grader.answer);
    return { correct, score: correct ? 1 : 0 };
  }

  if (grader.type === "json_fields") {
    const correct = gradeJsonFields(grader, answer);
    return { correct, score: correct ? 1 : 0 };
  }

  return { correct: false, score: 0 };
}

function gradeAnswerLenient(task, answer) {
  if (task.grader?.type === "json_fields") {
    const correct = gradeJsonFieldsLenient(task.grader, answer);
    return { correct, score: correct ? 1 : 0 };
  }
  return gradeAnswer(task, answer);
}

function getRunOr404(runId) {
  return readRun(runId);
}

function buildRunState(run, tasks) {
  const examTasks = tasksForRun(run, tasks);
  const examTaskIds = new Set(examTasks.map((task) => task.id));
  const examAnswers = Object.values(run.answers).filter((answer) => examTaskIds.has(answer.task_id));
  const submitted = examAnswers.length;
  const score = examAnswers.reduce((total, answer) => total + answer.score, 0);
  return {
    id: run.id,
    agent_name: run.agent_name,
    created_at: run.created_at,
    updated_at: run.updated_at,
    total_tasks: examTasks.length,
    bank_tasks: tasks.length,
    seed: run.seed || null,
    submitted,
    remaining: examTasks.length - submitted,
    score,
    complete: submitted >= examTasks.length,
  };
}

function buildResult(run, tasks) {
  const state = buildRunState(run, tasks);
  const examTasks = tasksForRun(run, tasks);
  return {
    ...state,
    accuracy: state.total_tasks ? state.score / state.total_tasks : 0,
    answers: examTasks.map((task, index) => {
      const answer = run.answers[task.id];
      return {
        index: index + 1,
        task_id: task.id,
        category: taskCategory(task),
        category_path: task.category_path || "",
        type: task.type,
        submitted: Boolean(answer),
        correct: answer?.correct ?? false,
        score: answer?.score ?? 0,
        answer: answer?.answer ?? null,
        submitted_at: answer?.submitted_at ?? null,
      };
    }),
  };
}

function isDemoRun(run) {
  if (run.is_demo === true || run.data_scope === "demo") {
    return true;
  }

  const name = String(run.agent_name || "").toLowerCase();
  return (
    /(^|[-_\s])(smoke|demo|fixture|debug|test)([-_\s]|$)/.test(name) ||
    name.includes("gt-smoke") ||
    name.includes("full-smoke")
  );
}

function buildRunSummary(run, tasks) {
  const state = buildRunState(run, tasks);
  const started = Date.parse(run.created_at);
  const updated = Date.parse(run.updated_at);
  const demo = isDemoRun(run);
  return {
    ...state,
    data_scope: demo ? "demo" : "real",
    is_demo: demo,
    accuracy: state.total_tasks ? state.score / state.total_tasks : 0,
    duration_ms: Number.isFinite(started) && Number.isFinite(updated) ? Math.max(0, updated - started) : null,
    result_url: `/run/${run.id}/result`,
    result_api_url: `/api/runs/${run.id}/result`,
  };
}

function isEmptyRealRun(run) {
  return !run.is_demo && run.submitted === 0;
}

function isStalledLowProgressRun(run, nowMs = Date.now()) {
  if (run.is_demo || run.complete || run.submitted <= 0 || run.submitted >= lowProgressSubmissionLimit) {
    return false;
  }

  const updated = Date.parse(run.updated_at || run.created_at);
  return Number.isFinite(updated) && nowMs - updated > stalledLowProgressMs;
}

function isVisibleRealRun(run, nowMs = Date.now()) {
  return !run.is_demo && run.submitted > 0 && !isStalledLowProgressRun(run, nowMs);
}

function filterRunsByScope(runs, scope, nowMs = Date.now()) {
  if (scope === "all") return runs;
  if (scope === "demo") return runs.filter((run) => run.is_demo);
  return runs.filter((run) => isVisibleRealRun(run, nowMs));
}

function emptyBucket() {
  return {
    attempts: 0,
    correct: 0,
    score: 0,
    timed_attempts: 0,
    submit_offset_total_ms: 0,
    accuracy: 0,
  };
}

function summarizeBucket(bucket) {
  const averageSubmitOffsetMs = bucket.timed_attempts ? Math.round(bucket.submit_offset_total_ms / bucket.timed_attempts) : null;
  return {
    ...bucket,
    average_submit_offset_ms: averageSubmitOffsetMs,
    accuracy: bucket.attempts ? bucket.correct / bucket.attempts : 0,
  };
}

function inferDifficultyFromAccuracy(accuracy) {
  if (accuracy >= 0.8) return "easy";
  if (accuracy >= 0.4) return "medium";
  return "hard";
}

function difficultyBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return "unknown";
  if (value <= 3) return "基础档";
  if (value <= 6) return "标准档";
  if (value <= 10) return "进阶档";
  return "高难档";
}

function suggestedScoreBandFromAccuracy(accuracy) {
  if (accuracy >= 0.85) return "基础档";
  if (accuracy >= 0.55) return "标准档";
  if (accuracy >= 0.3) return "进阶档";
  return "高难档";
}

function calibrationSignal(taskStats) {
  const current = String(taskStats.difficulty || "unknown").toLowerCase();
  const attempts = Number(taskStats.attempts) || 0;
  const accuracy = Number(taskStats.accuracy) || 0;
  const suggested = inferDifficultyFromAccuracy(accuracy);
  const score = Number(taskStats.difficulty_score);
  const hasScore = Number.isFinite(score);
  const band = difficultyBand(score);
  const suggestedBand = suggestedScoreBandFromAccuracy(accuracy);

  if (attempts < 5) {
    return {
      calibration_status: "样本不足",
      calibration_issue: "sample_low",
      suggested_difficulty: null,
      difficulty_band: band,
      suggested_difficulty_band: null,
      calibration_priority: 0,
    };
  }

  if (accuracy < 0.2) {
    return {
      calibration_status: "优先检查 GT/grader",
      calibration_issue: "grader_or_gt_check",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 3,
    };
  }

  if (hasScore && score <= 3 && accuracy < 0.65) {
    return {
      calibration_status: "基础档疑似偏难",
      calibration_issue: "score_band_underestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 2,
    };
  }

  if (hasScore && score >= 12 && accuracy > 0.7) {
    return {
      calibration_status: "高难档疑似偏易",
      calibration_issue: "score_band_overestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 2,
    };
  }

  if (hasScore && score >= 8 && score <= 10 && accuracy > 0.8) {
    return {
      calibration_status: "进阶档疑似偏易",
      calibration_issue: "score_band_overestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 1,
    };
  }

  if (hasScore && score >= 4 && score <= 8 && accuracy < 0.35) {
    return {
      calibration_status: "中档疑似偏难",
      calibration_issue: "score_band_underestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 2,
    };
  }

  if (current === "easy" && accuracy < 0.6) {
    return {
      calibration_status: "疑似低估难度",
      calibration_issue: "difficulty_underestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 2,
    };
  }

  if (current === "medium" && accuracy > 0.85) {
    return {
      calibration_status: "疑似高估难度",
      calibration_issue: "difficulty_overestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 1,
    };
  }

  if (current === "medium" && accuracy < 0.3) {
    return {
      calibration_status: "疑似低估难度",
      calibration_issue: "difficulty_underestimated",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 2,
    };
  }

  if (current === "hard" && accuracy > 0.7) {
    return {
      calibration_status: "疑似伪 hard",
      calibration_issue: "pseudo_hard",
      suggested_difficulty: suggested,
      difficulty_band: band,
      suggested_difficulty_band: suggestedBand,
      calibration_priority: 2,
    };
  }

  return {
    calibration_status: "基本一致",
    calibration_issue: "aligned",
    suggested_difficulty: current,
    difficulty_band: band,
    suggested_difficulty_band: suggestedBand,
    calibration_priority: 0,
  };
}

function buildStats(store, tasks, scope = "real") {
  const rawRuns = Object.values(store.runs || {});
  const allRuns = rawRuns.map((run) => buildRunSummary(run, tasks));
  const nowMs = Date.now();
  const runs = filterRunsByScope(allRuns, scope, nowMs);
  const demoRuns = allRuns.filter((run) => run.is_demo);
  const emptyRealRuns = allRuns.filter(isEmptyRealRun);
  const stalledLowProgressRuns = allRuns.filter((run) => isStalledLowProgressRun(run, nowMs));
  const includedRunIds = new Set(runs.map((run) => run.id));
  const completedRuns = runs.filter((run) => run.complete).length;
  const attempts = runs.reduce((total, run) => total + run.submitted, 0);
  const score = runs.reduce((total, run) => total + run.score, 0);
  const totalDuration = runs.reduce((total, run) => total + (run.duration_ms || 0), 0);
  const taskStats = new Map(
    tasks.map((task) => [
      task.id,
      {
        task_id: task.id,
        category: taskCategory(task),
        category_path: task.category_path || "",
        module: task.module || "",
        type: task.type,
        difficulty: task.difficulty || "unknown",
        difficulty_score: task.difficulty_score ?? null,
        cognitive_depth: task.cognitive_depth || "unknown",
        format_complexity: task.format_complexity || "unknown",
        info_density: task.info_density || "unknown",
        ...emptyBucket(),
      },
    ]),
  );
  const categoryStats = new Map();
  const typeStats = new Map();
  const moduleStats = new Map();
  const difficultyStats = new Map();
  const difficultyScoreStats = new Map();
  const cognitiveDepthStats = new Map();
  const formatComplexityStats = new Map();
  const infoDensityStats = new Map();

  for (const run of rawRuns) {
    if (!includedRunIds.has(run.id)) continue;

    for (const task of tasksForRun(run, tasks)) {
      const answer = run.answers[task.id];
      if (!answer) continue;
      const started = Date.parse(run.created_at);
      const submittedAt = Date.parse(answer.submitted_at);
      const submitOffsetMs = Number.isFinite(started) && Number.isFinite(submittedAt) ? Math.max(0, submittedAt - started) : null;

      const buckets = [
        taskStats.get(task.id),
        categoryStats.get(taskCategory(task)) || { category: taskCategory(task), ...emptyBucket() },
        moduleStats.get(task.module) || { module: task.module || "unknown", ...emptyBucket() },
        typeStats.get(task.type) || { type: task.type, ...emptyBucket() },
        difficultyStats.get(task.difficulty) || { difficulty: task.difficulty || "unknown", ...emptyBucket() },
        difficultyScoreStats.get(String(task.difficulty_score)) || {
          difficulty_score: task.difficulty_score ?? null,
          difficulty_band: difficultyBand(task.difficulty_score),
          ...emptyBucket(),
        },
        cognitiveDepthStats.get(task.cognitive_depth) || { cognitive_depth: task.cognitive_depth || "unknown", ...emptyBucket() },
        formatComplexityStats.get(task.format_complexity) || { format_complexity: task.format_complexity || "unknown", ...emptyBucket() },
        infoDensityStats.get(task.info_density) || { info_density: task.info_density || "unknown", ...emptyBucket() },
      ];

      for (const bucket of buckets) {
        bucket.attempts += 1;
        bucket.correct += answer.correct ? 1 : 0;
        bucket.score += answer.score || 0;
        if (submitOffsetMs !== null) {
          bucket.timed_attempts += 1;
          bucket.submit_offset_total_ms += submitOffsetMs;
        }
      }

      categoryStats.set(taskCategory(task), buckets[1]);
      moduleStats.set(task.module, buckets[2]);
      typeStats.set(task.type, buckets[3]);
      difficultyStats.set(task.difficulty, buckets[4]);
      difficultyScoreStats.set(String(task.difficulty_score), buckets[5]);
      cognitiveDepthStats.set(task.cognitive_depth, buckets[6]);
      formatComplexityStats.set(task.format_complexity, buckets[7]);
      infoDensityStats.set(task.info_density, buckets[8]);
    }
  }

  const byTask = [...taskStats.values()]
    .map(summarizeBucket)
    .map((task) => ({ ...task, ...calibrationSignal(task) }))
    .sort((left, right) => left.accuracy - right.accuracy || right.attempts - left.attempts || left.task_id.localeCompare(right.task_id));
  const stringFieldRisk = buildStringFieldRiskReport(tasks);
  const literalOnly = buildLiteralOnlyCandidates(runs, tasks);

  return {
    overview: {
      scope,
      total_runs: runs.length,
      real_runs: allRuns.filter((run) => isVisibleRealRun(run, nowMs)).length,
      demo_runs: demoRuns.length,
      empty_real_runs: emptyRealRuns.length,
      stalled_low_progress_runs: stalledLowProgressRuns.length,
      hidden_demo_runs: scope === "real" ? demoRuns.length : 0,
      hidden_empty_runs: scope === "real" ? emptyRealRuns.length : 0,
      hidden_stalled_runs: scope === "real" ? stalledLowProgressRuns.length : 0,
      completed_runs: completedRuns,
      total_tasks: Math.min(defaultExamTaskCount, tasks.length),
      bank_tasks: tasks.length,
      attempts,
      score,
      accuracy: attempts ? score / attempts : 0,
      average_run_duration_ms: runs.length ? Math.round(totalDuration / runs.length) : null,
      string_field_high_risk: stringFieldRisk.counts.high || 0,
      string_field_medium_risk: stringFieldRisk.counts.medium || 0,
      string_field_high_risk_tasks: stringFieldRisk.high_risk_tasks,
      literal_only_candidates: literalOnly.total,
    },
    string_field_risk: stringFieldRisk,
    literal_only_candidates: literalOnly,
    runs: runs.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
    by_category: [...categoryStats.values()].map(summarizeBucket).sort((left, right) => left.category.localeCompare(right.category)),
    by_module: [...moduleStats.values()].map(summarizeBucket).sort((left, right) => left.module.localeCompare(right.module)),
    by_type: [...typeStats.values()].map(summarizeBucket).sort((left, right) => left.type.localeCompare(right.type)),
    by_difficulty: [...difficultyStats.values()].map(summarizeBucket).sort((left, right) => left.difficulty.localeCompare(right.difficulty)),
    by_difficulty_score: [...difficultyScoreStats.values()]
      .map(summarizeBucket)
      .sort((left, right) => Number(left.difficulty_score) - Number(right.difficulty_score)),
    by_cognitive_depth: [...cognitiveDepthStats.values()].map(summarizeBucket).sort((left, right) => left.cognitive_depth.localeCompare(right.cognitive_depth)),
    by_format_complexity: [...formatComplexityStats.values()]
      .map(summarizeBucket)
      .sort((left, right) => left.format_complexity.localeCompare(right.format_complexity)),
    by_info_density: [...infoDensityStats.values()].map(summarizeBucket).sort((left, right) => left.info_density.localeCompare(right.info_density)),
    by_task: byTask,
  };
}

function nextTaskForRun(run, tasks) {
  const examTasks = tasksForRun(run, tasks);
  const nextIndex = examTasks.findIndex((task) => !run.answers[task.id]);
  if (nextIndex === -1) {
    return null;
  }
  return {
    index: nextIndex + 1,
    total: examTasks.length,
    task: publicTask(examTasks[nextIndex]),
  };
}

async function handleApi(request, response, url, tasks) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, tasks: tasks.length, exam_tasks: Math.min(defaultExamTaskCount, tasks.length) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      public_base_url: publicBaseUrl,
      local_base_url: `http://localhost:${port}`,
      bank_task_count: tasks.length,
      exam_task_count: Math.min(defaultExamTaskCount, tasks.length),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(response, 200, { total: tasks.length, tasks: tasks.map(publicTask) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const scope = url.searchParams.get("scope") || "real";
    const nowMs = Date.now();
    const runs = Object.values(readAllRuns().runs || {})
      .map((run) => buildRunSummary(run, tasks))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const filteredRuns = filterRunsByScope(runs, scope, nowMs);
    const demoRuns = runs.filter((run) => run.is_demo);
    const emptyRealRuns = runs.filter(isEmptyRealRun);
    const stalledLowProgressRuns = runs.filter((run) => isStalledLowProgressRun(run, nowMs));
    sendJson(response, 200, {
      scope,
      total: filteredRuns.length,
      real_runs: runs.filter((run) => isVisibleRealRun(run, nowMs)).length,
      demo_runs: demoRuns.length,
      empty_real_runs: emptyRealRuns.length,
      stalled_low_progress_runs: stalledLowProgressRuns.length,
      hidden_demo_runs: scope === "real" ? demoRuns.length : 0,
      hidden_empty_runs: scope === "real" ? emptyRealRuns.length : 0,
      hidden_stalled_runs: scope === "real" ? stalledLowProgressRuns.length : 0,
      runs: filteredRuns,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/stats") {
    sendJson(response, 200, buildStats(readAllRuns(), tasks, url.searchParams.get("scope") || "real"));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/runs") {
    const body = await readBody(request);
    const now = new Date().toISOString();
    const id = `run_${randomUUID()}`;
    const agentName = String(body.agent_name || body.agentName || "anonymous-agent").slice(0, 80);
    const dataScope = String(body.data_scope || body.dataScope || "").toLowerCase();
    const requestedSeed = body.seed === undefined || body.seed === null ? "" : String(body.seed).slice(0, 120);
    const seed = requestedSeed || randomUUID();
    const examTasks = sampleExamTasks(tasks, defaultExamTaskCount, seed);
    const run = {
      id,
      agent_name: agentName,
      created_at: now,
      updated_at: now,
      data_scope: dataScope === "demo" ? "demo" : "real",
      is_demo: dataScope === "demo" || isDemoRun({ agent_name: agentName }),
      seed,
      task_ids: examTasks.map((task) => task.id),
      answers: {},
    };

    createRun(run);
    sendJson(response, 201, {
      ...buildRunState(run, tasks),
      next_url: `/run/${id}`,
      api_next_url: `/api/runs/${id}/next`,
    });
    return;
  }

  if (parts[0] === "api" && parts[1] === "runs" && parts[2]) {
    const runId = parts[2];
    let run = getRunOr404(runId);

    if (!run) {
      sendJson(response, 404, { error: "Run not found." });
      return;
    }

    if (request.method === "GET" && parts.length === 3) {
      sendJson(response, 200, buildRunState(run, tasks));
      return;
    }

    if (request.method === "GET" && parts[3] === "next") {
      const next = nextTaskForRun(run, tasks);
      sendJson(response, 200, next ? { ...buildRunState(run, tasks), ...next } : { ...buildRunState(run, tasks), task: null });
      return;
    }

    if (request.method === "GET" && parts[3] === "result") {
      sendJson(response, 200, buildResult(run, tasks));
      return;
    }

    if (request.method === "POST" && parts[3] === "answers") {
      const body = await readBody(request);
      const taskId = body.task_id || body.taskId;
      const task = tasks.find((candidate) => candidate.id === taskId);
      const expectedNext = nextTaskForRun(run, tasks);

      if (Array.isArray(body.answers)) {
        sendJson(response, 400, { error: "Batch answer submission is not supported. Submit exactly one current task answer." });
        return;
      }

      if (!expectedNext) {
        sendJson(response, 409, { error: "Run is already complete." });
        return;
      }

      if (!task) {
        sendJson(response, 400, { error: "Unknown task_id." });
        return;
      }

      if (task.id !== expectedNext.task.id) {
        sendJson(response, 409, {
          error: "Answers must be submitted one task at a time in next-task order.",
          expected_task_id: expectedNext.task.id,
        });
        return;
      }

      const graded = gradeAnswer(task, body.answer);
      const submittedAt = new Date().toISOString();
      upsertAnswer(runId, task.id, body.answer, graded, submittedAt);
      run = getRunOr404(runId);

      sendJson(response, 200, {
        task_id: task.id,
        correct: graded.correct,
        score: graded.score,
        state: buildRunState(run, tasks),
        next: nextTaskForRun(run, tasks),
      });
      return;
    }
  }

  sendJson(response, 404, { error: "API endpoint not found." });
}

function serveStatic(response, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  let filePath = normalize(join(root, requestedPath));

  if (!filePath.startsWith(root)) {
    sendText(response, 404, "Not found");
    return;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    filePath = join(root, "index.html");
  }

  response.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(response);
}

function requestBaseUrl(request) {
  const host = request.headers.host || `localhost:${port}`;
  const forwardedProto = request.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = proto || (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`.replace(/\/$/, "");
}

ensureDataStore();
const tasks = loadTasks();

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://localhost:${port}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url, tasks);
      return;
    }

    if (url.pathname === "/r") {
      const baseUrl = requestBaseUrl(request);
      const runner = readFileSync(join(root, "runner.py"), "utf8").replace(
        'DEFAULT_BASE_URL = ""',
        `DEFAULT_BASE_URL = ${JSON.stringify(baseUrl)}`,
      );
      sendPython(response, 200, runner);
      return;
    }

    serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}).listen(port, () => {
  console.log(`Agent Arena: http://localhost:${port}`);
});
