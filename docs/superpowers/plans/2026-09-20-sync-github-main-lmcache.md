# GitHub Main LMCache Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GitHub PR #47 的 LMCache 精简渲染完整同步到 GitCode `dev4`，同时保留 8 卡 Decode 首节点隔离，并审计 GitHub `main` 尚未同步的 PR。

**Architecture:** 使用 PR #47 第一父提交作为共同基线，对 GitHub PR #47 结果和 GitCode `dev4` 当前文件执行三方合并。PR #47 决定 LMCache 控制面，GitCode 当前分支只保留后续部署修复与 `xds.optest/te-role` 调度契约。Shell 契约测试覆盖渲染和环境文件输出。

**Tech Stack:** Bash、内嵌 Python、PyYAML、Git、Helm Chart 文本补丁

**Spec:** `docs/superpowers/specs/2026-09-20-sync-github-main-lmcache.md`

## Global Constraints

- 目标分支为 GitCode `dev4`。
- GitHub PR #47 merge commit 固定为 `5d84e6e39846419cb975adb4d563a87a4b8c2f83`。
- 8 卡 Decode 使用第一个目标节点，Prefill 使用其余节点。
- 不删除 GitCode `dev4` 在 PR #47 之后已有的远程部署、映射地址和模板发现功能。
- 先看到新增/同步测试因缺少 PR #47 行为而失败，再修改生产脚本。

## Review Focus

- `ENABLE_LMCACHE=false` 时架构文件中的 `use_lmcache` 不能隐式开启 sidecar；由 LMCache probe 测试覆盖。
- tracing 开关关闭或 endpoint 为空时不能注入命令参数；由 render target labels 测试覆盖。
- tracing 重复处理不能重复添加参数；由 render target labels 测试覆盖。
- 只有一台目标机且 Decode 使用 8 卡时必须明确失败；由 pipeline contract 测试覆盖。
- 三方合并不能覆盖当前映射 XDS URL 和模板自动发现行为；由相关现有测试覆盖。

---

### Task 1: 同步 PR #47 的 LMCache 契约

**Files:**
- Modify: `worktable/pipeline/scripts/test/test_lmcache_sidecar_probes.sh`
- Modify: `worktable/pipeline/scripts/test/test_render_target_labels.sh`
- Modify: `worktable/pipeline/scripts/pull_render_config.sh`
- Modify: `worktable/pipeline/scripts/render-config.sh`

**Interfaces:**
- Consumes: `ENABLE_LMCACHE`、`ENABLE_LMCACHE_TRACING`、`LMCACHE_OTLP_ENDPOINT` 和现有模板中的 LMCache 参数锚点。
- Produces: pipeline 环境契约、精简 LMCache values 覆盖和可幂等的 tracing 参数注入。

- [ ] **Step 1: 写入 PR #47 的两份契约测试**

从 merge commit `5d84e6e` 读取两份测试的最终内容，并映射到 `worktable/pipeline/scripts/test/`。测试明确断言 sidecar 由 `ENABLE_LMCACHE` 控制、L2 默认开启、tracing 默认注入且可以关闭。

- [ ] **Step 2: 运行测试并确认 RED**

Run: `bash worktable/pipeline/scripts/test/test_lmcache_sidecar_probes.sh && bash worktable/pipeline/scripts/test/test_render_target_labels.sh`

Expected: 至少一项因当前脚本仍采用旧 LMCache 渲染契约而失败。

- [ ] **Step 3: 三方合并 PR #47 生产脚本**

对每个生产脚本执行 `git merge-file`：ours 为 PR #47 结果，base 为 PR #47 第一父提交，theirs 为 GitCode 当前文件。若有冲突，PR #47 决定 LMCache 段，GitCode 决定模板自动发现、目标地址映射及其后续修复。

- [ ] **Step 4: 运行 LMCache 契约测试并确认 GREEN**

Run: `bash worktable/pipeline/scripts/test/test_lmcache_sidecar_probes.sh && bash worktable/pipeline/scripts/test/test_render_target_labels.sh && bash worktable/pipeline/scripts/test/test_pull_render_environment_file.sh && bash worktable/pipeline/scripts/test/test_pull_render_target_sync.sh`

Expected: 全部退出码为 0。

### Task 2: 在新逻辑上验证 Decode/Prefill 节点隔离

**Files:**
- Modify: `worktable/pipeline/scripts/render-config.sh`
- Verify: `worktable/pipeline/test_pipeline_contract.sh`
- Verify: `worktable/pipeline/scripts/test/test_deploy_task_executor_readiness.sh`

**Interfaces:**
- Consumes: Task 1 合并后的 `groups`、`resources` 和 `target_ips`。
- Produces: `xds.optest/te-role` selector 与 `node-labels.json.assignments`。

- [ ] **Step 1: 运行调度回归测试**

Run: `bash worktable/pipeline/test_pipeline_contract.sh && bash worktable/pipeline/scripts/test/test_deploy_task_executor_readiness.sh`

Expected: 若 PR #47 合并移除了现有隔离段，测试以缺少 selector/assignments 失败；若三方合并已保留该段，测试直接通过，证明调度逻辑已基于新文件保留。

- [ ] **Step 2: 必要时回补最小调度实现**

在发现 8 卡 Decode 时为 TE 增加 `xds.optest/te-role`，并生成 Decode=`target_ips[0]`、Prefill=`target_ips[1:]` 的 assignments；目标节点不足两台时退出 2。

- [ ] **Step 3: 再次运行调度与 LMCache 测试**

Run: `bash worktable/pipeline/test_pipeline_contract.sh && bash worktable/pipeline/scripts/test/test_deploy_task_executor_readiness.sh && bash worktable/pipeline/scripts/test/test_lmcache_sidecar_probes.sh && bash worktable/pipeline/scripts/test/test_render_target_labels.sh`

Expected: 全部退出码为 0。

### Task 3: 审计 GitHub main PR 并完成交付

**Files:**
- Modify: `docs/superpowers/specs/2026-09-20-sync-github-main-lmcache.md`
- Modify: `docs/superpowers/plans/2026-09-20-sync-github-main-lmcache.md`

**Interfaces:**
- Consumes: GitHub `main` 合并 PR 列表、PR #36/#48 同步检查点和 GitCode `dev4` 最终树。
- Produces: 未同步 PR 清单、验证证据和 GitCode `dev4` 提交。

- [ ] **Step 1: 审计所有 merged PR**

Run: `gh pr list --repo TokensService/tokens-worktable --base main --state merged --limit 100 --json number,title,mergedAt,mergeCommit,headRefName`

Expected: 枚举全部 main merged PR；对 #48 之后的 #49、#51、#52 逐项检查特征文件，对此前 PR 用 #36/#48 同步点及最终树差异复核。

- [ ] **Step 2: 运行完整 pipeline 脚本测试集**

Run: `for test in worktable/pipeline/scripts/test/test_*.sh; do bash "$test"; done && bash worktable/pipeline/test_pipeline_contract.sh`

Expected: 全部退出码为 0；如存在与本次无关的基线失败，记录测试名和证据，不隐瞒。

- [ ] **Step 3: 检查 diff、提交并推送**

Run: `git diff --check && git status --short && git push origin HEAD:dev4`

Expected: diff 无空白错误，提交只含本规格范围内文件，远端 `dev4` 指向新提交。
