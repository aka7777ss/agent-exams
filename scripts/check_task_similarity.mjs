import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const inputPath = process.argv[2] || "data/tasks.json";
const outputDir = "outputs/cozelab-300-question-bank";
const reportPath = join(outputDir, "similarity_report.json");

const payload = JSON.parse(readFileSync(inputPath, "utf8"));
const tasks = Array.isArray(payload) ? payload : payload.tasks;

if (!Array.isArray(tasks)) {
  throw new Error(`No tasks array found in ${inputPath}`);
}

function stripCrossAppPrefix(text) {
  return text
    .replace(/^【[^】]+】/, "")
    .replace(/^跨应用材料来自[^。]+。 ?请基于这些跨系统信息完成判断或计算：/, "")
    .trim();
}

function normalizePrompt(prompt) {
  return stripCrossAppPrefix(prompt)
    .replace(/[A-Z]{1,5}-?\d{1,5}/g, "<ID>")
    .replace(/[A-Z]{1,5}_?\d{1,5}/g, "<ID>")
    .replace(/\b[A-Z]\b(?=[：:、.．\s])/g, "<OPT>")
    .replace(/\d{1,2}:\d{2}/g, "<TIME>")
    .replace(/\d+(?:\.\d+)?\s*(?:pct|%|元|万|小时|分钟|天|单|人|倍|位|条|次|分|万元)?/g, "<NUM>")
    .replace(/[A-Za-z]+/g, "<EN>")
    .replace(/[SKUOUPR]\d+/g, "<ID>")
    .replace(/[，。；：、“”‘’（）()【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function charNgrams(text, n = 3) {
  const compact = text.replace(/\s+/g, "");
  const grams = new Set();
  if (compact.length <= n) {
    grams.add(compact);
    return grams;
  }
  for (let index = 0; index <= compact.length - n; index += 1) {
    grams.add(compact.slice(index, index + n));
  }
  return grams;
}

function jaccard(a, b) {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

function taskInfo(task) {
  return {
    id: task.id,
    module: task.module,
    track: task.track,
    type: task.type,
    difficulty: task.difficulty,
    task_form: task.task_form,
    app_scope: task.app_scope,
    prompt: task.prompt,
  };
}

const enriched = tasks.map((task) => {
  const normalized = normalizePrompt(task.prompt);
  return {
    ...taskInfo(task),
    normalized,
    grams: charNgrams(normalized),
  };
});

const exactTemplateMap = new Map();
for (const task of enriched) {
  const key = task.normalized;
  if (!exactTemplateMap.has(key)) exactTemplateMap.set(key, []);
  exactTemplateMap.get(key).push(task.id);
}

const exactTemplateGroups = [...exactTemplateMap.entries()]
  .filter(([, ids]) => ids.length >= 2)
  .map(([normalized, ids]) => ({
    normalized,
    count: ids.length,
    ids,
  }))
  .sort((a, b) => b.count - a.count || a.ids[0].localeCompare(b.ids[0]));

const similarPairs = [];
for (let i = 0; i < enriched.length; i += 1) {
  for (let j = i + 1; j < enriched.length; j += 1) {
    const left = enriched[i];
    const right = enriched[j];
    const score = jaccard(left.grams, right.grams);
    if (score >= 0.78) {
      similarPairs.push({
        score: Number(score.toFixed(4)),
        ids: [left.id, right.id],
        modules: [left.module, right.module],
        tracks: [left.track, right.track],
      });
    }
  }
}
similarPairs.sort((a, b) => b.score - a.score || a.ids.join(",").localeCompare(b.ids.join(",")));

function buildComponents(pairs) {
  const parent = new Map();
  function find(value) {
    if (!parent.has(value)) parent.set(value, value);
    if (parent.get(value) !== value) parent.set(value, find(parent.get(value)));
    return parent.get(value);
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  }

  for (const pair of pairs) union(pair.ids[0], pair.ids[1]);
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  return [...groups.values()]
    .filter((ids) => ids.length >= 3)
    .map((ids) => ids.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

const similarGroups = buildComponents(similarPairs);
const taskById = new Map(enriched.map((task) => [task.id, task]));

const suspiciousGroups = similarGroups.map((ids) => {
  const groupTasks = ids.map((id) => taskById.get(id));
  const modules = [...new Set(groupTasks.map((task) => task.module))];
  const tracks = [...new Set(groupTasks.map((task) => task.track))];
  const forms = [...new Set(groupTasks.map((task) => task.task_form))];
  const types = [...new Set(groupTasks.map((task) => task.type))];
  const pairScores = similarPairs
    .filter((pair) => ids.includes(pair.ids[0]) && ids.includes(pair.ids[1]))
    .map((pair) => pair.score);
  const maxScore = Math.max(...pairScores);
  const minScore = Math.min(...pairScores);
  const risk =
    ids.length >= 6 || forms.includes("sandbox_workflow_seed") || maxScore >= 0.92
      ? "high"
      : ids.length >= 4 || maxScore >= 0.86
        ? "medium"
        : "low";

  return {
    risk,
    count: ids.length,
    ids,
    modules,
    tracks,
    types,
    task_forms: forms,
    score_range: [Number(minScore.toFixed(4)), Number(maxScore.toFixed(4))],
    sample_prompts: groupTasks.slice(0, 3).map((task) => ({ id: task.id, prompt: task.prompt })),
  };
});

const report = {
  source: inputPath,
  total_tasks: tasks.length,
  thresholds: {
    exact_template: "normalized prompt equality after removing numbers, ids, percentages, and cross-app prefixes",
    similar_pair_jaccard: 0.78,
    high_risk: "group size >= 6, any sandbox seed in group, or max pair score >= 0.92",
  },
  exact_template_groups: exactTemplateGroups,
  suspicious_groups: suspiciousGroups,
  top_similar_pairs: similarPairs.slice(0, 80),
};

mkdirSync(outputDir, { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  total_tasks: report.total_tasks,
  exact_template_groups: exactTemplateGroups.length,
  suspicious_groups: suspiciousGroups.length,
  high_risk_groups: suspiciousGroups.filter((group) => group.risk === "high").length,
  report: reportPath,
}, null, 2));

for (const group of suspiciousGroups.slice(0, 12)) {
  console.log(`\n[${group.risk}] ${group.count} tasks | ${group.ids.join(", ")}`);
  console.log(`  modules: ${group.modules.join(" / ")}`);
  console.log(`  tracks: ${group.tracks.join(" / ")}`);
  console.log(`  score: ${group.score_range.join(" - ")}`);
  console.log(`  sample: ${group.sample_prompts[0].prompt.slice(0, 180)}`);
}
