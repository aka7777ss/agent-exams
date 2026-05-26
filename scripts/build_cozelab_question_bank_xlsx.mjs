import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "outputs/cozelab-300-question-bank";
const tasksPath = `${outputDir}/cozelab_300_tasks.json`;
const outputPath = `${outputDir}/cozelab_300_question_bank.xlsx`;

const payload = JSON.parse(await fs.readFile(tasksPath, "utf8"));
const tasks = payload.tasks;

const workbook = Workbook.create();
const overview = workbook.worksheets.getOrAdd("总览", { renameFirstIfOnlyNewSpreadsheet: true });
const bank = workbook.worksheets.add("题库明细");
const importSheet = workbook.worksheets.add("基础导入格式");
const scoring = workbook.worksheets.add("评分说明");

function write(sheet, address, rows) {
  sheet.getRange(address).values = rows;
}

function styleHeader(sheet, address) {
  const range = sheet.getRange(address);
  range.format = {
    fill: "#1F4E79",
    font: { color: "#FFFFFF", bold: true },
    horizontalAlignment: "center",
    verticalAlignment: "center",
    wrapText: true,
  };
}

function setWidths(sheet, widths) {
  widths.forEach((width, index) => {
    const letter = String.fromCharCode("A".charCodeAt(0) + index);
    sheet.getRange(`${letter}:${letter}`).format.columnWidthPx = width;
  });
}

function countsBy(field) {
  return tasks.reduce((acc, task) => {
    acc[task[field]] = (acc[task[field]] || 0) + 1;
    return acc;
  }, {});
}

function displayAnswer(task) {
  if (task.type === "json") return JSON.stringify(task.grader.required_fields);
  if (task.grader.answer !== undefined) return String(task.grader.answer);
  if (task.grader.min !== undefined && task.grader.max !== undefined) {
    const midpoint = (Number(task.grader.min) + Number(task.grader.max)) / 2;
    return String(Math.round((midpoint + Number.EPSILON) * 1000000) / 1000000);
  }
  return "";
}

const moduleCounts = countsBy("module");
const typeCounts = countsBy("type");
const difficultyCounts = countsBy("difficulty");
const appScopeCounts = countsBy("app_scope");
const taskFormCounts = countsBy("task_form");

write(overview, "A1:D1", [["Cozelab Agent 真实工作场景能力题库", "", "", ""]]);
overview.getRange("A1:D1").format = {
  fill: "#0F172A",
  font: { color: "#FFFFFF", bold: true, size: 16 },
  horizontalAlignment: "left",
};
write(overview, "A3:B8", [
  ["总题量", tasks.length],
  ["通用能力题", moduleCounts["通用能力"]],
  ["行业能力题", tasks.length - moduleCounts["通用能力"]],
  ["通用/行业比例", "30% / 70%"],
  ["版本", payload.metadata.version],
  ["语言", payload.metadata.language],
]);
styleHeader(overview, "A10:B10");
write(overview, "A10:B17", [
  ["模块", "题量"],
  ...Object.entries(moduleCounts),
]);
styleHeader(overview, "D10:E10");
write(overview, "D10:E13", [
  ["题型", "题量"],
  ...Object.entries(typeCounts),
]);
styleHeader(overview, "G10:H10");
write(overview, "G10:H13", [
  ["难度", "题量"],
  ...Object.entries(difficultyCounts),
]);
styleHeader(overview, "A20:B20");
write(overview, "A20:B27", [
  ["设计原则", "说明"],
  ...payload.metadata.design_principles.map((item, index) => [`原则 ${index + 1}`, item]),
]);
styleHeader(overview, "G20:H20");
write(overview, "G20:H24", [
  ["应用范围/任务形态", "题量"],
  ...Object.entries(appScopeCounts).map(([key, value]) => [key, value]),
  ...Object.entries(taskFormCounts).map(([key, value]) => [key, value]),
]);
styleHeader(overview, "D20:F20");
write(overview, "D20:F24", [
  ["参考材料", "使用方式", "链接/路径"],
  ...payload.metadata.referenced_benchmarks.map((item) => [item.name, item.note, item.url]),
]);
setWidths(overview, [180, 110, 24, 180, 520, 430, 120, 80]);
overview.getRange("A1:H27").format.wrapText = true;

const detailHeaders = [
  "ID",
  "module",
  "track",
  "category",
  "difficulty",
  "type",
  "modality",
  "app_scope",
  "task_form",
  "apps_involved",
  "workflow_steps_estimate",
  "asset_types",
  "prompt",
  "options",
  "answer",
  "grader",
  "capability_tags",
  "source_inspiration",
  "explanation",
];
const detailRows = tasks.map((task) => [
  task.id,
  task.module,
  task.track,
  task.category,
  task.difficulty,
  task.type,
  task.modality,
  task.app_scope,
  task.task_form,
  (task.apps_involved || []).join(", "),
  task.workflow_steps_estimate,
  (task.asset_types || []).join(", "),
  task.prompt,
  (task.options || []).map((option) => `${option.id}. ${option.text}`).join("\n"),
  displayAnswer(task),
  JSON.stringify(task.grader),
  (task.capability_tags || []).join(", "),
  "Cozelab + referenced agent benchmarks",
  task.explanation || "",
]);
write(bank, `A1:S${detailRows.length + 1}`, [detailHeaders, ...detailRows]);
styleHeader(bank, "A1:S1");
bank.freezePanes.freezeRows(1);
setWidths(bank, [80, 130, 150, 230, 90, 100, 100, 150, 170, 260, 130, 220, 560, 360, 220, 360, 220, 260, 420]);
bank.getRange(`A1:S${detailRows.length + 1}`).format = {
  verticalAlignment: "top",
  wrapText: true,
};
styleHeader(bank, "A1:S1");

const importHeaders = ["ID", "题型", "分类", "题目", "GT"];
const typeLabels = { single_choice: "单选", multiple_choice: "多选", number: "数字", json: "JSON" };
const importRows = tasks.map((task) => [
  task.id,
  typeLabels[task.type] || task.type,
  task.category,
  (task.options || []).length
    ? `${task.prompt}\n${task.options.map((option) => `${option.id}. ${option.text}`).join("\n")}`
    : task.prompt,
  displayAnswer(task),
]);
write(importSheet, `A1:E${importRows.length + 1}`, [importHeaders, ...importRows]);
styleHeader(importSheet, "A1:E1");
importSheet.freezePanes.freezeRows(1);
setWidths(importSheet, [80, 80, 230, 680, 260]);
importSheet.getRange(`A1:E${importRows.length + 1}`).format = {
  verticalAlignment: "top",
  wrapText: true,
};
styleHeader(importSheet, "A1:E1");

write(scoring, "A1:C1", [["题型", "平台判分方式", "备注"]]);
write(scoring, "A2:C10", [
  ["single_choice", "exact_match", "按选项 ID 完全匹配。"],
  ["number", "number_range", "支持容差；明细中的 grader.min/max 为准。"],
  ["json", "json_fields", "required_fields 必须匹配，允许额外字段。"],
  ["distribution", "90 通用 + 210 行业", "行业题均分到 6 个重点赛道，每赛道 35 题。"],
  ["difficulty", "semantic rules", "按任务所需能力语义打标，不按题号打散。"],
  ["easy", "单步/单阈值", payload.metadata.difficulty_rules.easy],
  ["medium", "多步骤/多条件/结构化", payload.metadata.difficulty_rules.medium],
  ["hard", "高风险边界/审查", payload.metadata.difficulty_rules.hard],
  ["review", "explanation 不对参赛 agent 暴露", "用于专家核题、定位争议题和后续转沙盒任务。"],
]);
write(scoring, "E1:G1", [["跨应用字段", "含义", "当前分布"]]);
write(scoring, "E2:G8", [
  ["app_scope", "none / multi_app_simulated", JSON.stringify(appScopeCounts)],
  ["task_form", "structured_answer / sandbox_workflow_seed", JSON.stringify(taskFormCounts)],
  ["apps_involved", "题目涉及的业务系统列表", "60 题非空"],
  ["workflow_steps_estimate", "结构化版估算 1 或 3-5；沙盒种子 20+", "12 题为 20+"],
  ["asset_types", "未来沙盒或材料题可挂载的资产类型", "当前仍为 text_only 摘录"],
  ["sandbox seed", "每个行业 2 题预留为沙盒任务种子", "6 个行业共 12 题"],
  ["current modality", "当前 300 题仍为文本结构化题", JSON.stringify(countsBy("modality"))],
]);
styleHeader(scoring, "A1:C1");
styleHeader(scoring, "E1:G1");
setWidths(scoring, [160, 220, 620, 24, 180, 360, 360]);
scoring.getRange("A1:G10").format.wrapText = true;

for (const [sheetName, range] of [
  ["总览", "A1:H27"],
  ["题库明细", "A1:S25"],
  ["基础导入格式", "A1:E25"],
  ["评分说明", "A1:G10"],
]) {
  await workbook.render({ sheetName, range, scale: 1 });
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 20 },
  summary: "final formula error scan",
});

if (errors.ndjson && errors.ndjson.includes('"matches"')) {
  console.log(errors.ndjson);
}

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
