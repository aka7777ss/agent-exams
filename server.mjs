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
      is_demo INTEGER NOT NULL DEFAULT 0
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
  `);
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
  execFileSync("sqlite3", [dbFile, sql], { encoding: "utf8" });
}

function dbQuery(sql) {
  const output = execFileSync("sqlite3", ["-json", dbFile, sql], { encoding: "utf8" }).trim();
  return output ? JSON.parse(output) : [];
}

function rowToRun(row) {
  return {
    id: row.id,
    agent_name: row.agent_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    data_scope: row.data_scope,
    is_demo: Boolean(row.is_demo),
    answers: {},
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
  const runRows = dbQuery("SELECT id, agent_name, created_at, updated_at, data_scope, is_demo FROM runs;");
  const answerRows = dbQuery("SELECT run_id, task_id, answer_json, correct, score, submitted_at FROM answers;");

  for (const row of runRows) {
    runs[row.id] = rowToRun(row);
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
    SELECT id, agent_name, created_at, updated_at, data_scope, is_demo
    FROM runs
    WHERE id = ${sqlString(runId)}
    LIMIT 1;
  `);
  if (!rows.length) {
    return null;
  }

  const run = rowToRun(rows[0]);
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
  dbExec(`
    INSERT INTO runs (id, agent_name, created_at, updated_at, data_scope, is_demo)
    VALUES (
      ${sqlString(run.id)},
      ${sqlString(run.agent_name)},
      ${sqlString(run.created_at)},
      ${sqlString(run.updated_at)},
      ${sqlString(run.data_scope)},
      ${run.is_demo ? 1 : 0}
    );
  `);
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
      INSERT OR IGNORE INTO runs (id, agent_name, created_at, updated_at, data_scope, is_demo)
      VALUES (
        ${sqlString(run.id)},
        ${sqlString(run.agent_name || "anonymous-agent")},
        ${sqlString(run.created_at)},
        ${sqlString(run.updated_at || run.created_at)},
        ${sqlString(demo ? "demo" : "real")},
        ${demo ? 1 : 0}
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
    return deepEqual(actual, expected.normalized_value);
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

function getRunOr404(runId) {
  return readRun(runId);
}

function buildRunState(run, tasks) {
  const submitted = Object.keys(run.answers).length;
  const score = Object.values(run.answers).reduce((total, answer) => total + answer.score, 0);
  return {
    id: run.id,
    agent_name: run.agent_name,
    created_at: run.created_at,
    updated_at: run.updated_at,
    total_tasks: tasks.length,
    submitted,
    remaining: tasks.length - submitted,
    score,
    complete: submitted >= tasks.length,
  };
}

function buildResult(run, tasks) {
  const state = buildRunState(run, tasks);
  return {
    ...state,
    accuracy: state.total_tasks ? state.score / state.total_tasks : 0,
    answers: tasks.map((task, index) => {
      const answer = run.answers[task.id];
      return {
        index: index + 1,
        task_id: task.id,
        category: task.category,
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

function filterRunsByScope(runs, scope) {
  if (scope === "all") return runs;
  if (scope === "demo") return runs.filter((run) => run.is_demo);
  return runs.filter((run) => !run.is_demo && run.submitted > 0);
}

function emptyBucket() {
  return {
    attempts: 0,
    correct: 0,
    score: 0,
    accuracy: 0,
  };
}

function summarizeBucket(bucket) {
  return {
    ...bucket,
    accuracy: bucket.attempts ? bucket.correct / bucket.attempts : 0,
  };
}

function buildStats(store, tasks, scope = "real") {
  const rawRuns = Object.values(store.runs || {});
  const allRuns = rawRuns.map((run) => buildRunSummary(run, tasks));
  const runs = filterRunsByScope(allRuns, scope);
  const demoRuns = allRuns.filter((run) => run.is_demo);
  const emptyRealRuns = allRuns.filter((run) => !run.is_demo && run.submitted === 0);
  const includedRunIds = new Set(runs.map((run) => run.id));
  const completedRuns = runs.filter((run) => run.complete).length;
  const attempts = runs.reduce((total, run) => total + run.submitted, 0);
  const score = runs.reduce((total, run) => total + run.score, 0);
  const totalDuration = runs.reduce((total, run) => total + (run.duration_ms || 0), 0);
  const taskStats = new Map(tasks.map((task) => [task.id, { task_id: task.id, category: task.category, type: task.type, ...emptyBucket() }]));
  const categoryStats = new Map();
  const typeStats = new Map();

  for (const run of rawRuns) {
    if (!includedRunIds.has(run.id)) continue;

    for (const task of tasks) {
      const answer = run.answers[task.id];
      if (!answer) continue;

      const buckets = [
        taskStats.get(task.id),
        categoryStats.get(task.category) || { category: task.category, ...emptyBucket() },
        typeStats.get(task.type) || { type: task.type, ...emptyBucket() },
      ];

      for (const bucket of buckets) {
        bucket.attempts += 1;
        bucket.correct += answer.correct ? 1 : 0;
        bucket.score += answer.score || 0;
      }

      categoryStats.set(task.category, buckets[1]);
      typeStats.set(task.type, buckets[2]);
    }
  }

  const byTask = [...taskStats.values()]
    .map(summarizeBucket)
    .sort((left, right) => left.accuracy - right.accuracy || right.attempts - left.attempts || left.task_id.localeCompare(right.task_id));

  return {
    overview: {
      scope,
      total_runs: runs.length,
      real_runs: allRuns.filter((run) => !run.is_demo && run.submitted > 0).length,
      demo_runs: demoRuns.length,
      empty_real_runs: emptyRealRuns.length,
      hidden_demo_runs: scope === "real" ? demoRuns.length : 0,
      hidden_empty_runs: scope === "real" ? emptyRealRuns.length : 0,
      completed_runs: completedRuns,
      total_tasks: tasks.length,
      attempts,
      score,
      accuracy: attempts ? score / attempts : 0,
      average_run_duration_ms: runs.length ? Math.round(totalDuration / runs.length) : null,
    },
    runs: runs.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))),
    by_category: [...categoryStats.values()].map(summarizeBucket).sort((left, right) => left.category.localeCompare(right.category)),
    by_type: [...typeStats.values()].map(summarizeBucket).sort((left, right) => left.type.localeCompare(right.type)),
    by_task: byTask,
  };
}

function nextTaskForRun(run, tasks) {
  const nextIndex = tasks.findIndex((task) => !run.answers[task.id]);
  if (nextIndex === -1) {
    return null;
  }
  return {
    index: nextIndex + 1,
    total: tasks.length,
    task: publicTask(tasks[nextIndex]),
  };
}

async function handleApi(request, response, url, tasks) {
  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true, tasks: tasks.length });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    sendJson(response, 200, {
      public_base_url: publicBaseUrl,
      local_base_url: `http://localhost:${port}`,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    sendJson(response, 200, { total: tasks.length, tasks: tasks.map(publicTask) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/runs") {
    const scope = url.searchParams.get("scope") || "real";
    const runs = Object.values(readAllRuns().runs || {})
      .map((run) => buildRunSummary(run, tasks))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const filteredRuns = filterRunsByScope(runs, scope);
    const demoRuns = runs.filter((run) => run.is_demo);
    const emptyRealRuns = runs.filter((run) => !run.is_demo && run.submitted === 0);
    sendJson(response, 200, {
      scope,
      total: filteredRuns.length,
      real_runs: runs.filter((run) => !run.is_demo && run.submitted > 0).length,
      demo_runs: demoRuns.length,
      empty_real_runs: emptyRealRuns.length,
      hidden_demo_runs: scope === "real" ? demoRuns.length : 0,
      hidden_empty_runs: scope === "real" ? emptyRealRuns.length : 0,
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
    const run = {
      id,
      agent_name: agentName,
      created_at: now,
      updated_at: now,
      data_scope: dataScope === "demo" ? "demo" : "real",
      is_demo: dataScope === "demo" || isDemoRun({ agent_name: agentName }),
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
