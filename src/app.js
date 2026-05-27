const app = document.querySelector("#app");
const taskData = document.querySelector("#task-data");
const shell = document.querySelector(".shell");

const state = {
  run: null,
  current: null,
  config: null,
  adminRefreshTimer: null,
};

function html(strings, ...values) {
  return strings.reduce((result, string, index) => {
    const value = values[index] ?? "";
    return result + string + value;
  }, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "请求失败");
  }

  return payload;
}

function setRoute(path) {
  window.history.pushState({}, "", path);
  renderRoute();
}

function runIdFromPath() {
  const match = window.location.pathname.match(/^\/run\/([^/]+)/);
  return match?.[1];
}

function progressPercent(run) {
  if (!run || !run.total_tasks) {
    return 0;
  }
  return Math.round((run.submitted / run.total_tasks) * 100);
}

function setPageMode(mode) {
  if (mode !== "admin" && state.adminRefreshTimer) {
    clearTimeout(state.adminRefreshTimer);
    state.adminRefreshTimer = null;
  }
  shell.classList.toggle("is-admin", mode === "admin");
}

function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return `${hours}h ${minuteRest}m`;
}

async function loadConfig() {
  if (!state.config) {
    state.config = await requestJson("/api/config");
  }
  return state.config;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function buildRunnerCommand(baseUrl, agentName) {
  const base = baseUrl.replace(/\/$/, "");
  return `python3 <(curl -fsSL ${shellQuote(`${base}/r`)}) ${shellQuote(agentName || "my-agent")}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function renderStart() {
  const config = await loadConfig();
  const localBase = window.location.origin || config.local_base_url;
  const publicBase = config.public_base_url;
  const bankTaskCount = config.bank_task_count || 300;
  const examTaskCount = config.exam_task_count || 60;
  const defaultAgentName = "my-agent";
  const command = buildRunnerCommand(localBase, defaultAgentName);

  taskData.textContent = "";
  setPageMode("home");
  app.className = "startSurface";
  app.innerHTML = html`
    <div class="modeIntro">
      <p class="eyebrow">Choose a mode</p>
      <p>网页、命令行和 API 是平行入口；每次创建 run 会从 ${bankTaskCount} 题题库中按题型和难度分层抽取 ${examTaskCount} 题。</p>
    </div>
    <div class="modeGrid">
      <section class="modeCard webMode">
        <p class="eyebrow">Browser</p>
        <h3>网页答题</h3>
        <p>适合人类预览、Browser Agent 直接操作页面。逐题提交后自动进入下一题。</p>
        <div class="modeFacts">
          <span>人类可预览</span>
          <span>真实网页交互</span>
          <span>自动生成结果页</span>
        </div>
        <form class="startForm" data-start-form>
          <label>
            Agent 名称
            <input name="agent_name" autocomplete="off" placeholder="例如：gpt-browser-agent-v1" />
          </label>
          <button class="primaryButton" type="submit">
            <span aria-hidden="true">▶</span>
            开始网页测试
          </button>
        </form>
      </section>

      <section class="modeCard commandMode isFeatured">
        <p class="eyebrow">Command</p>
        <h3>默认答题脚本</h3>
        <p>复制这条命令给 agent，即可启动官方终端脚本；脚本会一题一题展示题面并提交答案。</p>
        <div class="modeFacts">
          <span>逐题显示题面</span>
          <span>终端输入答案</span>
          <span>自动提交结果</span>
        </div>
        <label>
          命令里的 Agent 名称
          <input name="command_agent_name" data-command-agent-name autocomplete="off" value="${escapeHtml(defaultAgentName)}" />
        </label>
        <div class="commandBox">
          <div class="commandHead">
            <strong>启动脚本命令</strong>
            <button class="secondaryButton small" type="button" data-copy-command>复制</button>
          </div>
          <pre class="commandBlock" data-copy-command title="点击复制命令"><code data-command>${escapeHtml(command)}</code></pre>
          <p class="hint">这是默认推荐的命令行交互方式：agent 只需要读取题面，在终端输入答案，不需要自己写批量上传脚本。发给云端 agent 时请使用线上页面的命令。</p>
        </div>
      </section>

      <section class="modeCard apiMode" id="api">
        <p class="eyebrow">API</p>
        <h3>API 接入</h3>
        <p>适合平台集成或自建评测系统。默认命令行参与已由官方脚本封装好，不要求 agent 自己实现 API 调用。</p>
        <div class="modeFacts">
          <span>三步接入</span>
          <span>不暴露 GT</span>
          <span>适合批量跑分</span>
        </div>
        <details class="apiDetails">
          <summary>
            <span>
              <small class="eyebrow">Docs</small>
              <strong>查看接口</strong>
            </span>
            <i aria-hidden="true">⌄</i>
          </summary>
          <div class="apiStep">
            <span>1</span>
            <div>
              <h4>创建 run</h4>
              <pre><code>POST /api/runs
{"agent_name":"my-agent"}</code></pre>
            </div>
          </div>
          <div class="apiStep">
            <span>2</span>
            <div>
              <h4>获取下一题</h4>
              <pre><code>GET /api/runs/{run_id}/next</code></pre>
            </div>
          </div>
          <div class="apiStep">
            <span>3</span>
            <div>
              <h4>提交当前题答案</h4>
              <pre><code>POST /api/runs/{run_id}/answers
{"task_id":"q001","answer":"B"}</code></pre>
            </div>
          </div>
          <p class="hint">提交接口只接受当前下一题的单题答案，不支持批量上传。每个题目页面都会同步写入 <code>#task-data</code>，方便网页 agent 读取结构化题面。</p>
        </details>
      </section>
    </div>
    <div class="statusStrip">
      <span><strong>${examTaskCount}</strong> 题 / 次</span>
      <span>${bankTaskCount} 题题库分层抽样</span>
      <span>单选 / 多选 / JSON / 数值 / 短文本</span>
      <span>统一 run 与结果页</span>
      <span>${publicBase ? "线上命令已启用" : "本地命令已启用"}</span>
    </div>
  `;

  const commandAgentName = app.querySelector("[data-command-agent-name]");
  const commandEl = app.querySelector("[data-command]");

  function refreshCommands() {
    const agentName = commandAgentName.value || "my-agent";
    commandEl.textContent = buildRunnerCommand(localBase, agentName);
  }

  commandAgentName.addEventListener("input", refreshCommands);

  app.querySelectorAll("[data-copy-command]").forEach((control) => {
    control.addEventListener("click", async () => {
      await copyText(commandEl.textContent);
      const button = control.matches("button") ? control : app.querySelector("button[data-copy-command]");
      if (!button) return;
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制";
      }, 1200);
    });
  });

  app.querySelector("[data-start-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const agentName = form.get("agent_name") || "anonymous-agent";
    const run = await requestJson("/api/runs", {
      method: "POST",
      body: JSON.stringify({ agent_name: agentName }),
    });
    setRoute(run.next_url);
  });
}

function renderTaskControls(task) {
  if (task.type === "single_choice") {
    return html`
      <div class="choiceGrid">
        ${task.options
          .map(
            (option) => html`
              <label class="choice">
                <input type="radio" name="answer" value="${escapeHtml(option.id)}" required />
                <span>${escapeHtml(option.id)}</span>
                <strong>${escapeHtml(option.text)}</strong>
              </label>
            `,
          )
          .join("")}
      </div>
    `;
  }

  if (task.type === "multiple_choice") {
    return html`
      <div class="choiceGrid">
        ${task.options
          .map(
            (option) => html`
              <label class="choice">
                <input type="checkbox" name="answer" value="${escapeHtml(option.id)}" />
                <span>${escapeHtml(option.id)}</span>
                <strong>${escapeHtml(option.text)}</strong>
              </label>
            `,
          )
          .join("")}
      </div>
    `;
  }

  if (task.type === "number") {
    return html`
      <label class="answerField">
        数字答案
        <input name="answer" inputmode="decimal" autocomplete="off" required />
      </label>
    `;
  }

  if (task.type === "percentage") {
    return html`
      <label class="answerField">
        百分比答案
        <input name="answer" inputmode="decimal" autocomplete="off" placeholder="例如：30%、30 或 0.3" required />
      </label>
    `;
  }

  if (task.type === "json") {
    return html`
      <label class="answerField">
        JSON 答案
        <textarea name="answer" rows="8" spellcheck="false" required>{}</textarea>
      </label>
    `;
  }

  return html`
    <label class="answerField">
      文本答案
      <textarea name="answer" rows="6" required></textarea>
    </label>
  `;
}

function readAnswer(form, type) {
  if (type === "multiple_choice") {
    return [...form.querySelectorAll('input[name="answer"]:checked')].map((input) => input.value);
  }

  if (type === "json") {
    return JSON.parse(form.elements.answer.value);
  }

  if (type === "number" || type === "percentage") {
    return form.elements.answer.value.trim();
  }

  return form.elements.answer.value;
}

async function loadRun(runId) {
  const next = await requestJson(`/api/runs/${runId}/next`);
  state.run = next;
  state.current = next.task ? next : null;
  return next;
}

function renderProgress(run) {
  return html`
    <div class="progressCard">
      <div>
        <span>${escapeHtml(run.agent_name)}</span>
        <strong>${run.submitted} / ${run.total_tasks}</strong>
      </div>
      <div class="progressTrack" aria-label="答题进度">
        <i style="width:${progressPercent(run)}%"></i>
      </div>
      <a href="/api/runs/${run.id}/result" target="_blank" rel="noreferrer">结果 JSON</a>
    </div>
  `;
}

function renderTask(next) {
  if (!next.task) {
    renderResult(next.id);
    return;
  }

  const task = next.task;
  taskData.textContent = JSON.stringify(task, null, 2);
  setPageMode("run");
  app.className = "panel primaryPanel";
  app.innerHTML = html`
    ${renderProgress(next)}
    <article class="taskCard">
      <div class="taskMeta">
        <span>第 ${next.index} / ${next.total} 题</span>
        <span>${escapeHtml(task.category)}</span>
        <span>${escapeHtml(task.type)}</span>
      </div>
      <h2>${escapeHtml(task.prompt)}</h2>
      <form data-answer-form>
        ${renderTaskControls(task)}
        <div class="formActions">
          <button class="primaryButton" type="submit">
            <span aria-hidden="true">✓</span>
            提交答案
          </button>
          <button class="secondaryButton" type="button" data-refresh>
            刷新题目
          </button>
        </div>
        <p class="errorText" data-error hidden></p>
      </form>
    </article>
    <details class="machineBox">
      <summary>当前题目的结构化 JSON</summary>
      <pre><code>${escapeHtml(JSON.stringify(task, null, 2))}</code></pre>
    </details>
  `;

  app.querySelector("[data-refresh]").addEventListener("click", () => renderRoute());
  app.querySelector("[data-answer-form]").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = form.querySelector("[data-error]");

    try {
      const answer = readAnswer(form, task.type);
      const result = await requestJson(`/api/runs/${next.id}/answers`, {
        method: "POST",
        body: JSON.stringify({ task_id: task.id, answer }),
      });
      if (result.state.complete) {
        setRoute(`/run/${next.id}/result`);
      } else {
        renderTask({ ...result.state, ...result.next });
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
    }
  });
}

async function renderResult(runId) {
  const result = await requestJson(`/api/runs/${runId}/result`);
  taskData.textContent = "";
  setPageMode("run");
  app.className = "panel primaryPanel";
  const percent = Math.round(result.accuracy * 100);

  app.innerHTML = html`
    <div class="resultHero">
      <p class="eyebrow">Result</p>
      <h2>${percent}%</h2>
      <p>${escapeHtml(result.agent_name)} 完成 ${result.submitted} / ${result.total_tasks} 题，得分 ${result.score}。</p>
      <div class="resultActions">
        <a class="primaryButton" href="/api/runs/${result.id}/result" target="_blank" rel="noreferrer">
          打开结果 JSON
        </a>
        <button class="secondaryButton" type="button" data-new-run>新建 run</button>
      </div>
    </div>
    <div class="answerTable" role="table" aria-label="逐题结果">
      <div class="answerRow head" role="row">
        <span>题号</span>
        <span>题目</span>
        <span>状态</span>
        <span>得分</span>
      </div>
      ${result.answers
        .map(
          (answer) => html`
            <div class="answerRow" role="row">
              <span>${answer.index}</span>
              <span>${escapeHtml(answer.task_id)} · ${escapeHtml(answer.category)}</span>
              <span>${answer.submitted ? (answer.correct ? "正确" : "错误") : "未答"}</span>
              <span>${answer.score}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;

  app.querySelector("[data-new-run]").addEventListener("click", () => setRoute("/run/new"));
}

async function renderAdmin() {
  if (state.adminRefreshTimer) {
    clearTimeout(state.adminRefreshTimer);
    state.adminRefreshTimer = null;
  }

  const stats = await requestJson("/api/stats");
  taskData.textContent = "";
  setPageMode("admin");
  app.className = "adminSurface";

  const hardestTasks = stats.by_task.filter((task) => task.attempts > 0).slice(0, 10);
  const calibrationTasks = stats.by_task
    .filter((task) => task.attempts > 0)
    .sort(
      (left, right) =>
        (right.calibration_priority || 0) - (left.calibration_priority || 0) ||
        right.attempts - left.attempts ||
        left.task_id.localeCompare(right.task_id),
    )
    .slice(0, 30);
  const calibrationIssues = stats.by_task.filter((task) => (task.calibration_priority || 0) > 0).length;
  const calibrationSampleLow = stats.by_task.filter((task) => task.attempts > 0 && task.calibration_issue === "sample_low").length;
  const recentRuns = stats.runs.slice(0, 20);

  app.innerHTML = html`
    <div class="adminHeader">
      <div>
        <p class="eyebrow">Stats</p>
        <h2>测试统计</h2>
        <p>这里默认只展示有效真实 run：隐藏 demo/debug/test 数据、0 进度空 run，以及低进度且 10 分钟无更新的停滞 run。耗时目前按 run 的创建到最后提交粗略计算。</p>
        <div class="liveMeta">
          <span><i aria-hidden="true"></i>实时刷新中</span>
          <span>最后更新：${formatDate(new Date().toISOString())}</span>
        </div>
      </div>
      <div class="resultActions">
        <a class="secondaryButton" href="/api/runs?scope=real" target="_blank" rel="noreferrer">真实 Runs JSON</a>
        <a class="secondaryButton" href="/api/stats?scope=real" target="_blank" rel="noreferrer">真实 Stats JSON</a>
        <a class="secondaryButton" href="/api/stats?scope=all" target="_blank" rel="noreferrer">全部数据 JSON</a>
      </div>
    </div>

    <section class="metricGrid" aria-label="统计概览">
      <div class="metricCard">
        <span>总 Run 数</span>
        <strong>${stats.overview.total_runs}</strong>
      </div>
      <div class="metricCard">
        <span>已完成 Run</span>
        <strong>${stats.overview.completed_runs}</strong>
      </div>
      <div class="metricCard">
        <span>总体正确率</span>
        <strong>${formatPercent(stats.overview.accuracy)}</strong>
      </div>
      <div class="metricCard">
        <span>总提交题数</span>
        <strong>${stats.overview.attempts}</strong>
      </div>
      <div class="metricCard softMetric">
        <span>隐藏调试 Run</span>
        <strong>${stats.overview.hidden_demo_runs}</strong>
      </div>
      <div class="metricCard softMetric">
        <span>隐藏空 Run</span>
        <strong>${stats.overview.hidden_empty_runs}</strong>
      </div>
      <div class="metricCard softMetric">
        <span>隐藏停滞 Run</span>
        <strong>${stats.overview.hidden_stalled_runs}</strong>
      </div>
      <div class="metricCard softMetric">
        <span>待校准题</span>
        <strong>${calibrationIssues}</strong>
      </div>
      <div class="metricCard softMetric">
        <span>样本不足题</span>
        <strong>${calibrationSampleLow}</strong>
      </div>
    </section>

    <section class="adminGrid">
      <article class="statPanel">
        <div class="statPanelHead">
          <h3>最近测试</h3>
          <span>${stats.runs.length} runs</span>
        </div>
        <div class="statTable runTable" role="table" aria-label="最近测试">
          <div class="statRow head" role="row">
            <span>Agent</span>
            <span>进度</span>
            <span>正确率</span>
            <span>耗时</span>
            <span>时间</span>
            <span>结果</span>
          </div>
          ${
            recentRuns.length
              ? recentRuns
                  .map(
                    (run) => html`
                      <div class="statRow" role="row">
                        <span>${escapeHtml(run.agent_name)}</span>
                        <span>${run.submitted}/${run.total_tasks}</span>
                        <span>${formatPercent(run.accuracy)}</span>
                        <span>${formatDuration(run.duration_ms)}</span>
                        <span>${formatDate(run.created_at)}</span>
                        <a href="${escapeHtml(run.result_url)}">打开</a>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="emptyLine">暂无测试记录</div>'
          }
        </div>
      </article>

      <article class="statPanel">
        <div class="statPanelHead">
          <h3>模块正确率</h3>
          <span>category</span>
        </div>
        <div class="barList">
          ${
            stats.by_category.length
              ? stats.by_category
                  .map(
                    (item) => html`
                      <div class="barItem">
                        <div>
                          <strong>${escapeHtml(item.category)}</strong>
                          <span>${item.correct}/${item.attempts}</span>
                        </div>
                        <i><b style="width:${Math.round(item.accuracy * 100)}%"></b></i>
                        <em>${formatPercent(item.accuracy)}</em>
                      </div>
                    `,
                  )
                  .join("")
              : '<p class="hint">还没有可统计的答题记录。</p>'
          }
        </div>
      </article>

      <article class="statPanel">
        <div class="statPanelHead">
          <h3>高频错题 / 难题</h3>
          <span>按正确率升序</span>
        </div>
        <div class="statTable taskTable" role="table" aria-label="高频错题">
          <div class="statRow head" role="row">
            <span>题号</span>
            <span>模块</span>
            <span>题型</span>
            <span>提交</span>
            <span>正确率</span>
          </div>
          ${
            hardestTasks.length
              ? hardestTasks
                  .map(
                    (task) => html`
                      <div class="statRow" role="row">
                        <span>${escapeHtml(task.task_id)}</span>
                        <span>${escapeHtml(task.category)}</span>
                        <span>${escapeHtml(task.type)}</span>
                        <span>${task.attempts}</span>
                        <span>${formatPercent(task.accuracy)}</span>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="emptyLine">还没有错题统计</div>'
          }
        </div>
      </article>

      <article class="statPanel calibrationPanel">
        <div class="statPanelHead">
          <h3>题目校准</h3>
          <span>按校准优先级排序</span>
        </div>
        <div class="statTable calibrationTable" role="table" aria-label="题目校准">
          <div class="statRow head" role="row">
            <span>题号</span>
            <span>模块</span>
            <span>题型</span>
            <span>标注难度</span>
            <span>提交</span>
            <span>正确率</span>
            <span>建议难度</span>
            <span>状态</span>
          </div>
          ${
            calibrationTasks.length
              ? calibrationTasks
                  .map(
                    (task) => html`
                      <div class="statRow" role="row">
                        <span>${escapeHtml(task.task_id)}</span>
                        <span>${escapeHtml(task.module || task.category)}</span>
                        <span>${escapeHtml(task.type)}</span>
                        <span>${escapeHtml(task.difficulty)}</span>
                        <span>${task.attempts}</span>
                        <span>${formatPercent(task.accuracy)}</span>
                        <span>${escapeHtml(task.suggested_difficulty || "-")}</span>
                        <span><b class="calibrationBadge priority-${task.calibration_priority || 0}">${escapeHtml(task.calibration_status)}</b></span>
                      </div>
                    `,
                  )
                  .join("")
              : '<div class="emptyLine">还没有可校准的题目数据</div>'
          }
        </div>
        <p class="hint">规则：提交数少于 5 先标为样本不足；easy 正确率低于 60% 视为可能低估；medium 高于 85% 可能高估、低于 30% 可能低估；hard 高于 70% 视为疑似伪 hard；低于 20% 优先检查 GT/grader。</p>
      </article>

      <article class="statPanel">
        <div class="statPanelHead">
          <h3>题型正确率</h3>
          <span>type</span>
        </div>
        <div class="barList">
          ${
            stats.by_type.length
              ? stats.by_type
                  .map(
                    (item) => html`
                      <div class="barItem">
                        <div>
                          <strong>${escapeHtml(item.type)}</strong>
                          <span>${item.correct}/${item.attempts}</span>
                        </div>
                        <i><b style="width:${Math.round(item.accuracy * 100)}%"></b></i>
                        <em>${formatPercent(item.accuracy)}</em>
                      </div>
                    `,
                  )
                  .join("")
              : '<p class="hint">还没有可统计的答题记录。</p>'
          }
        </div>
      </article>
    </section>
  `;

  state.adminRefreshTimer = setTimeout(() => {
    if (window.location.pathname === "/admin") {
      renderAdmin();
    }
  }, 5000);
}

async function renderRoute() {
  const runId = runIdFromPath();

  try {
    if (window.location.pathname === "/admin") {
      await renderAdmin();
      return;
    }

    if (window.location.pathname === "/" || window.location.pathname === "/run/new") {
      await renderStart();
      return;
    }

    if (runId && window.location.pathname.endsWith("/result")) {
      await renderResult(runId);
      return;
    }

    if (runId) {
      const next = await loadRun(runId);
      renderTask(next);
      return;
    }

    renderStart();
  } catch (error) {
    setPageMode("run");
    app.className = "panel primaryPanel";
    app.innerHTML = html`
      <div class="emptyState">
        <h2>页面加载失败</h2>
        <p>${escapeHtml(error.message)}</p>
        <button class="primaryButton" type="button" data-home>回到开始</button>
      </div>
    `;
    app.querySelector("[data-home]").addEventListener("click", () => setRoute("/run/new"));
  }
}

window.addEventListener("popstate", renderRoute);
renderRoute();
