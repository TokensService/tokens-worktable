const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

function initProfilingSimulation() {
  const steps = [...document.querySelectorAll(".flow-step")];
  const startButton = $("#startSimulation");
  if (!steps.length || !startButton) return;

  const resetButton = $("#resetSimulation");
  const metricStep = $("#metricStep");
  const metricStatus = $("#metricStatus");
  const simulationLog = $("#simulationLog");
  const reportScore = $("#reportScore");
  const messages = [
    "正在确认模型路径、架构和目标资源。",
    "正在模拟调用 Jenkins 部署模块。",
    "正在执行预热请求和健康检查。",
    "正在采集延迟、吞吐、GPU 利用率和 trace。",
    "正在分析可能的性能瓶颈。",
    "正在生成优化建议和验证计划。",
    "报告已生成，等待接入真实 profiling 数据。",
  ];
  let timer = null;
  let current = -1;

  function render(index) {
    steps.forEach((step, stepIndex) => {
      step.classList.toggle("done", stepIndex < index);
      step.classList.toggle("active", stepIndex === index);
      const badge = step.querySelector(".badge");
      if (stepIndex < index) badge.textContent = "已完成";
      else if (stepIndex === index) badge.textContent = "进行中";
      else badge.textContent = "待开始";
    });
    const completed = Math.max(0, Math.min(index, steps.length));
    metricStep.textContent = `${completed}/${steps.length}`;
    metricStatus.textContent = index >= steps.length ? "已完成" : index >= 0 ? "运行中" : "待开始";
    simulationLog.textContent = index >= 0 && index < messages.length ? messages[index] : "流程模拟已完成。";
    reportScore.textContent = index >= steps.length ? "91" : "--";
  }

  function stop() {
    if (timer) window.clearInterval(timer);
    timer = null;
  }

  startButton.addEventListener("click", () => {
    stop();
    current = 0;
    render(current);
    timer = window.setInterval(() => {
      current += 1;
      render(current);
      if (current >= steps.length) stop();
    }, 850);
  });

  resetButton.addEventListener("click", () => {
    stop();
    current = -1;
    render(current);
    simulationLog.textContent = "点击“开始模拟流程”后，这里会展示当前阶段说明。";
  });

  render(current);
}

function initDeployModule() {
  const deployForm = $("#deployForm");
  if (!deployForm) return;

  const gpuNodes = $("#gpuNodes");
  const summary = $("#summary");
  const stages = $("#stages");
  const logs = $("#logs");
  const buildNumberInput = $("#buildNumberInput");
  let logOffset = 0;

  function renderGpu(data) {
    const selected = new Set(data.selected_node_ips || []);
    const entries = Object.entries(data.nodes || {});
    if (!entries.length) {
      gpuNodes.textContent = "暂无 GPU 节点数据。";
      return;
    }
    gpuNodes.innerHTML = entries
      .map(([ip, info]) => `
        <button class="node" type="button" data-ip="${ip}">
          <strong>${ip}</strong>
          <span>空闲 GPU：${info.gpu_free ?? 0}/${info.gpu_total ?? 0}</span>
          <span>状态：${info.status || "未知"}${selected.has(ip) ? " · 推荐" : ""}</span>
        </button>
      `)
      .join("");
  }

  function renderSummary(data) {
    const liveLog = data.live_log_url
      ? `<a href="${data.live_log_url}" target="_blank" rel="noreferrer">打开实时日志</a>`
      : "";
    summary.innerHTML = [
      ["队列 ID", data.queue_id ?? ""],
      ["构建编号", data.build_number ?? ""],
      ["是否构建中", data.building ? "是" : "否"],
      ["结果", data.result ?? ""],
      ["实时日志", liveLog],
    ].map(([label, value]) => `<div class="summary-item"><strong>${label}</strong>${value}</div>`).join("");
    stages.innerHTML = (data.stages || [])
      .map((stage) => `<div class="stage"><strong>${stage.name}</strong>${stage.status || ""}</div>`)
      .join("");
    if (data.build_number) {
      buildNumberInput.value = data.build_number;
    }
  }

  async function refreshGpu() {
    const required = $("#requiredGpus").value || "0";
    try {
      renderGpu(await api(`/api/gpu?required_gpus=${encodeURIComponent(required)}`));
    } catch (error) {
      gpuNodes.textContent = `GPU 状态获取失败：${error.message}`;
    }
  }

  async function refreshStatus() {
    const buildNumber = buildNumberInput.value;
    if (!buildNumber) return;
    renderSummary(await api(`/api/builds/${buildNumber}`));
    const logData = await api(`/api/builds/${buildNumber}/logs?offset=${logOffset}`);
    logOffset = logData.next_offset;
    if (logData.text) {
      logs.textContent += logData.text;
    }
  }

  deployForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(deployForm);
    logs.textContent = "";
    logOffset = 0;
    const payload = Object.fromEntries(form.entries());
    payload.auto_uninstall_on_failure = form.get("auto_uninstall_on_failure") === "on";
    renderSummary(await api("/api/deploy", { method: "POST", body: JSON.stringify(payload) }));
  });

  gpuNodes.addEventListener("click", (event) => {
    const node = event.target.closest("[data-ip]");
    if (!node) return;
    deployForm.elements.deploy_node_ips.value = node.dataset.ip;
  });

  $("#refreshGpu").addEventListener("click", refreshGpu);
  $("#refreshStatus").addEventListener("click", refreshStatus);
  $("#requiredGpus").addEventListener("change", refreshGpu);
  $("#uninstallBuild").addEventListener("click", async () => {
    const buildNumber = Number(buildNumberInput.value);
    if (!buildNumber) return;
    renderSummary(await api("/api/uninstall", {
      method: "POST",
      body: JSON.stringify({ build_number: buildNumber, executor: "agent-api" }),
    }));
  });

  refreshGpu();
}

initProfilingSimulation();
initDeployModule();
