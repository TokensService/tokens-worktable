# Pipeline Parallel Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicitly grouped parallel pipeline tasks whose visual layout, execution, cancellation, variables, logs, Prometheus collection, API behavior, and scheduled behavior are consistent.

**Architecture:** Persist an optional `parallel: true` flag on ordinary stages and derive maximal consecutive groups at runtime; preset stages are barriers. The browser keeps the existing stage executors behind a batch coordinator with task-local runtime contexts, while the server extracts its stage loop into a result-returning executor and runs the same groups concurrently with deterministic output merging and shared cancellation.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Node.js 22 ESM, TypeScript, `node:test`, `node:vm`, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-11-pipeline-parallel-tasks-design.md`

## Global Constraints

- Only `parallel === true` enables parallel execution; a missing or invalid value stays serial.
- A maximal consecutive run of parallel ordinary stages is one group; every preset stage is a non-parallel barrier.
- The orchestration view must draw a visible fork and join, while stage details show only the selected task's output.
- Every task in a group reads the same upstream variable snapshot; successful outputs merge in orchestration order, with later stages winning duplicate keys.
- The first blocking failure cancels unfinished peers, prevents downstream work, and records those peers as `aborted`.
- Retrying a failed parallel task reruns its whole group from the group-entry variable snapshot.
- A parallel group performs at most one Prometheus collection, using the longest eligible marked task; serial task collection is unchanged.
- Browser, API, and scheduled execution share these semantics; the existing API request body does not change.
- No new dependency, named parallel groups, DAG syntax, or concurrency limit is introduced.

---

### Task 1: Stage grouping contract, editor persistence, and fork/join rendering

**Files:**
- Create: `projects/pipeline/tests/test_parallel_stage_ui.js`
- Modify: `projects/pipeline/pipeline.html:38-95`
- Modify: `projects/pipeline/pipeline.html:2484-2645`
- Modify: `projects/pipeline/pipeline.html:2924-3027`
- Modify: `projects/pipeline/pipeline.html:5855-5960`
- Modify: `projects/pipeline/pipeline.html:6086-6110`

**Interfaces:**
- Produces: `pipelineStageGroups(stages) -> Array<{ start, end, parallel, stages }>`, with exclusive `end`.
- Produces: persisted optional stage field `parallel: true` and editor control `data-f="parallel"`.
- Produces: `.pipeline-parallelGroup`, `.pipeline-parallelRailIn`, `.pipeline-parallelRailOut`, and `.pipeline-parallelTasks` DOM structure.

- [ ] **Step 1: Write the failing grouping and UI tests**

Create the test file with a brace-aware function extractor and these assertions:

```js
const fs = require('node:fs')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const source = fs.readFileSync(process.env.PIPELINE_HTML || __dirname + '/../pipeline.html', 'utf8')

function extractFunction(name) {
  const match = new RegExp('function\\s+' + name + '\\s*\\(').exec(source)
  assert.ok(match, 'missing function ' + name)
  const bodyStart = source.indexOf('{', match.index)
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) return source.slice(match.index, i + 1)
  }
  throw new Error('unterminated function ' + name)
}

test('连续 parallel 普通任务成组，预设任务和串行任务切断分组', () => {
  const context = {}
  vm.createContext(context)
  vm.runInContext(extractFunction('pipelineStageGroups'), context)
  const groups = context.pipelineStageGroups([
    { id: 'prepare' },
    { id: 'build', parallel: true },
    { id: 'test', parallel: true },
    { id: '__check__', preset: true, parallel: true },
    { id: 'eval', parallel: true },
    { id: 'deploy' },
  ])
  assert.deepEqual(groups.map(group => ({
    start: group.start,
    end: group.end,
    parallel: group.parallel,
    ids: group.stages.map(stage => stage.id),
  })), [
    { start: 0, end: 1, parallel: false, ids: ['prepare'] },
    { start: 1, end: 3, parallel: true, ids: ['build', 'test'] },
    { start: 3, end: 4, parallel: false, ids: ['__check__'] },
    { start: 4, end: 5, parallel: true, ids: ['eval'] },
    { start: 5, end: 6, parallel: false, ids: ['deploy'] },
  ])
})

test('编辑器、持久化和编排图公开并行任务契约', () => {
  assert.match(source, /data-f="parallel"/)
  assert.match(source, /if\(s\.parallel\) st\.parallel=true/)
  assert.match(source, /parallel:!!s\.parallel/)
  assert.match(source, /pipeline-parallelGroup/)
  assert.match(source, /⚡ 并行组/)
})
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node --test projects/pipeline/tests/test_parallel_stage_ui.js`

Expected: FAIL because `pipelineStageGroups` and the editor/rendering contract do not exist.

- [ ] **Step 3: Implement the grouping helper and configuration round-trip**

Add this pure helper near `flowStages`:

```js
function pipelineStageGroups(stages){
  const list=Array.isArray(stages)?stages:[], groups=[];
  for(let i=0;i<list.length;){
    const first=list[i];
    if(first && !first.preset && first.parallel===true){
      let end=i+1;
      while(end<list.length && list[end] && !list[end].preset && list[end].parallel===true) end++;
      groups.push({start:i,end:end,parallel:true,stages:list.slice(i,end)}); i=end;
    }else{
      groups.push({start:i,end:i+1,parallel:false,stages:[first]}); i++;
    }
  }
  return groups;
}
```

Update `newStage`, `openPlForm`, `savePlForm`, and the change delegate with `parallel:false`, `parallel:!!s.parallel`, `if(s.parallel) st.parallel=true`, and `s.parallel=e.target.checked`. Do not add the field to preset marker objects.

- [ ] **Step 4: Render a parallel group as an explicit fork/join**

Extract existing node creation into `createFlowNode(stage, index)`. Make `renderFlow` iterate derived groups and append multi-stage groups in this exact structure:

```html
<div class="pipeline-parallelGroup">
  <div class="pipeline-parallelTitle">⚡ 并行组</div>
  <div class="pipeline-parallelRailIn"></div>
  <div class="pipeline-parallelTasks"></div>
  <div class="pipeline-parallelRailOut"></div>
</div>
```

Append the existing `.pipeline-node` elements inside `.pipeline-parallelTasks` so selectors, status classes, click-to-select, selected-task-only detail logs, double-click editing, and drag handlers remain unchanged. Render a one-stage marked group as a normal node with a `⚡` marker and no artificial fork.

- [ ] **Step 5: Run focused UI tests and verify GREEN**

Run: `node --test projects/pipeline/tests/test_parallel_stage_ui.js projects/pipeline/tests/test_cleanup_flow.js projects/pipeline/tests/test_stage_drag_reorder.js projects/pipeline/tests/test_pipeline_readonly.js`

Expected: PASS with no failures; click, drag, preset, and read-only behavior remains intact.

- [ ] **Step 6: Commit the configuration and visualization slice**

```bash
git add projects/pipeline/pipeline.html projects/pipeline/tests/test_parallel_stage_ui.js
git commit -m "feat: 配置并绘制流水线并行任务"
```

---

### Task 2: Browser parallel success path and deterministic variable merge

**Files:**
- Create: `projects/pipeline/tests/test_parallel_stage_execution.js`
- Modify: `projects/pipeline/pipeline.html:2836-2865`
- Modify: `projects/pipeline/pipeline.html:3706-3721`
- Modify: `projects/pipeline/pipeline.html:4157-4683`

**Interfaces:**
- Consumes: `pipelineStageGroups(stages)` from Task 1.
- Produces: `rootRunContext(rc)`, `startStageAt(rc,index)`, `createParallelStageContext(parent,index,varsSnapshot)`, `settleParallelStage(child,status)`, and `runParallelStageGroup(parent,group)`.

- [ ] **Step 1: Write a failing concurrency barrier test**

Use deferred stage stubs so the test does not depend on wall-clock timing:

```js
test('并行任务同时启动并等待全组成功后才启动后续任务', async () => {
  const { context, rc, started } = parallelContext([
    { id: 'a', parallel: true, script: { path: '/a.sh' } },
    { id: 'b', parallel: true, script: { path: '/b.sh' } },
    { id: 'after', script: { path: '/after.sh' } },
  ])
  context.advance(rc, 0)
  assert.deepEqual(started.map(call => call.index), [0, 1])
  started[1].child.nodes.b = { status: 'success', varsOut: { VALUE: 'b' } }
  context.advance(started[1].child, 2)
  await tick()
  assert.deepEqual(started.map(call => call.index), [0, 1])
  started[0].child.nodes.a = { status: 'success', varsOut: { VALUE: 'a', A: '1' } }
  context.advance(started[0].child, 1)
  await tick()
  assert.deepEqual(started.map(call => call.index), [0, 1, 2])
  assert.deepEqual(rc.vars, { VALUE: 'b', A: '1' })
})
```

`parallelContext` loads the grouping/coordinator functions in a VM. Its `runScriptStep(child,index)` records `{ child, index }`; all other stage executors throw if called. Define `tick` as `() => new Promise(resolve => setImmediate(resolve))`.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test projects/pipeline/tests/test_parallel_stage_execution.js`

Expected: FAIL because only stage 0 starts and task-local contexts do not exist.

- [ ] **Step 3: Add task-local contexts and parent-aware rendering**

Resolve selection/rendering through the parent while keeping child timers, cancellation, and variables isolated:

```js
function rootRunContext(rc){ return rc&&rc.parallelParent?rc.parallelParent:rc; }
function runSetSel(rc,id){
  const root=rootRunContext(rc); rc.selId=id; root.selId=id;
  if(viewRc===root) selectedId=id;
}
function rcRender(rc,withFlow){
  const root=rootRunContext(rc); if(viewRc!==root) return;
  applyStatusClasses(); if(withFlow) renderFlow(); renderDetail();
}
```

Apply the same root lookup to `rcOverall`, `maybeRenderLiveDetail`, and the direct `viewRc===rc` checks in `runStage` and the EvalTokens terminal callback. `createParallelStageContext` shallow-copies run metadata, shares `stages` and `nodes`, resets `timer` and `scriptAbort`, clones the group-entry variables, and stores parent/index/settlement promise fields.

- [ ] **Step 4: Split single-stage dispatch from batch advancement**

Move the existing kind checks into `startStageAt`. Child advancement settles only that child; parent advancement derives the next group:

```js
function advance(rc,i){
  if(rc.parallelParent){ settleParallelStage(rc,'success'); return; }
  taskPromFinalize(rc);
  if(i>=rc.stages.length){ finish(rc,'success'); return; }
  const group=pipelineStageGroups(rc.stages).find(g=>g.start===i);
  if(group&&group.parallel&&group.end-group.start>1){ runParallelStageGroup(rc,group); return; }
  startStageAt(rc,i);
}
```

Create all child contexts before dispatching any stage, start every child synchronously, await their promises, merge each successful node's `varsOut` in ascending stage order, clear the active group, scan Prometheus completion, and advance to `group.end`.

- [ ] **Step 5: Run browser engine regression tests and verify GREEN**

Run: `node --test projects/pipeline/tests/test_parallel_stage_execution.js projects/pipeline/tests/test_abort_token_guard.js projects/pipeline/tests/test_execution_progress.js projects/pipeline/tests/test_jenkins_stage_vars.js projects/pipeline/tests/evaltokens-stage.test.mjs`

Expected: PASS; the deferred test proves overlap, the barrier, and orchestration-order variable merging.

- [ ] **Step 6: Commit the browser success path**

```bash
git add projects/pipeline/pipeline.html projects/pipeline/tests/test_parallel_stage_execution.js
git commit -m "feat: 并行推进浏览器流水线任务"
```

---

### Task 3: Browser failure cancellation, whole-group retry, and user abort

**Files:**
- Modify: `projects/pipeline/tests/test_parallel_stage_execution.js`
- Modify: `projects/pipeline/pipeline.html:4050-4305`
- Modify: `projects/pipeline/pipeline.html:4686-4720`
- Modify: `projects/pipeline/pipeline.html:6011-6025`

**Interfaces:**
- Consumes: the active parent group and child contexts from Task 2.
- Produces: `cancelParallelStage(child,reason)`, `cancelParallelGroup(parent,exceptChild)`, and `pipelineStageGroupAt(stages,index)`.
- Extends: browser Jenkins/HTTP helpers with an optional `AbortSignal`, and adds `abortablePipelineDelay(ms,signal)` for polling waits.

- [ ] **Step 1: Write failing failure, user-abort, and retry tests**

```js
test('首个失败取消在途同伴且不启动后续任务', async () => {
  const fixture = parallelContext(parallelThenAfter())
  fixture.context.advance(fixture.rc, 0)
  fixture.started[0].child.nodes.a = { status: 'failed', progress: 100, varsOut: {} }
  fixture.context.finish(fixture.started[0].child, 'failed')
  await tick()
  assert.equal(fixture.rc.nodes.b.status, 'aborted')
  assert.equal(fixture.started[1].child.scriptAbort.signal.aborted, true)
  assert.deepEqual(fixture.started.map(call => call.index), [0, 1])
  assert.deepEqual(fixture.finished, ['failed'])
})

test('失败阶段重试从并行组首项开始并恢复组入口变量', () => {
  const fixture = retryContext()
  fixture.context.retryFromStage('b')
  assert.deepEqual(fixture.advanced, [0])
  assert.deepEqual(fixture.rc.vars, { UPSTREAM: 'snapshot' })
  assert.equal(fixture.rc.nodes.a.status, 'idle')
  assert.equal(fixture.rc.nodes.b.status, 'idle')
})
```

Add a user-abort case asserting both child signals are aborted, both running nodes become `aborted`, and parent history receives one aborted result. Add an HTTP-peer case whose mocked fetch remains pending until its signal is aborted; this proves group failure cancels browser HTTP work as well as script streaming. Keep the existing EvalTokens signal path and cover simulated peers by asserting their timers are cleared during cancellation.

- [ ] **Step 2: Run the new cases and verify RED**

Run: `node --test projects/pipeline/tests/test_parallel_stage_execution.js`

Expected: FAIL because peer cancellation is absent and retry starts at the clicked stage.

- [ ] **Step 3: Implement fail-fast group cancellation**

Insert this guard at the very start of the existing `finish` function, before setting `rc.over` or touching history:

```js
if(rc&&rc.parallelParent){ settleParallelStage(rc,result); return; }
```

On the first child `failed` result, mark the group failed, abort every unsettled peer's `scriptAbort`, clear its timer, archive partial output, convert its running node to `aborted`, set `child.over=true`, and resolve its promise. Wait for all child promises before calling `finish(parent,'failed')`; late executor returns see `child.over` and are discarded.

Give `runUrlStep` its own controller in `rc.scriptAbort`, pass its signal through crumb, trigger, status, and console fetch helpers, and replace the fixed polling timeout with `abortablePipelineDelay`. Clear the controller only when it is still the stage's active controller. Existing direct-URL and remote-proxy requests must both receive the signal.

- [ ] **Step 4: Apply group-aware retry and user abort**

In `retryFromStage`, replace the clicked index with the containing group's `start`, restore variables from that first node's `varsIn`, and reset outputs, archive markers, Prometheus timestamps, and nodes from the group start through the pipeline end. In `abortRun`, cancel the active parallel group before the existing archive/status/history loop.

- [ ] **Step 5: Run failure and legacy abort tests and verify GREEN**

Run: `node --test projects/pipeline/tests/test_parallel_stage_execution.js projects/pipeline/tests/test_abort_token_guard.js projects/pipeline/tests/test_server_stage_logs.js projects/pipeline/tests/evaltokens-stage.test.mjs`

Expected: PASS; failure, abort, and late-result states remain stable.

- [ ] **Step 6: Commit browser cancellation and retry**

```bash
git add projects/pipeline/pipeline.html projects/pipeline/tests/test_parallel_stage_execution.js
git commit -m "feat: 取消并重试并行任务组"
```

---

### Task 4: One longest Prometheus collection per browser parallel group

**Files:**
- Modify: `projects/pipeline/tests/test_parallel_stage_execution.js`
- Modify: `projects/pipeline/tests/test_cleanup_flow.js`
- Modify: `projects/pipeline/pipeline.html:5065-5096`

**Interfaces:**
- Consumes: `pipelineStageGroups` and per-task `_promT0` timestamps.
- Produces: `parallelPromCandidate(rc,group) -> { stage, index, startMs, endMs } | null`.
- Produces: `_promT1` completion timestamps and an idempotent `_promGroupCollected` marker.

- [ ] **Step 1: Write failing selection and de-duplication tests**

```js
test('并行组只为运行时间最长的合格勾选任务采集一次', async () => {
  const rc = {
    stages: [
      { id: 'a', name: '短任务', parallel: true, promCollect: true, _promT0: 1000, _promT1: 4000 },
      { id: 'b', name: '最长任务', parallel: true, promCollect: true, _promT0: 1000, _promT1: 9000 },
      { id: 'c', name: '已取消', parallel: true, promCollect: true, _promT0: 1000, _promT1: 12000 },
    ],
    nodes: { a: { status: 'success' }, b: { status: 'failed' }, c: { status: 'aborted' } },
  }
  const group = context.pipelineStageGroups(rc.stages)[0]
  const picked = context.parallelPromCandidate(rc, group)
  assert.equal(picked.stage, rc.stages[1])
  assert.equal(picked.startMs, 1000)
  assert.equal(picked.endMs, 9000)
  context.taskPromFinalize(rc)
  context.taskPromFinalize(rc)
  await tick()
  assert.deepEqual(calls.map(call => call.name), ['最长任务'])
})
```

Add a tie case that expects the earlier stage and retain the existing serial collection test in `test_cleanup_flow.js`.

- [ ] **Step 2: Run Prometheus tests and verify RED**

Run: `node --test projects/pipeline/tests/test_parallel_stage_execution.js projects/pipeline/tests/test_cleanup_flow.js`

Expected: FAIL because `taskPromFinalize` currently launches one collection for each terminal marked stage.

- [ ] **Step 3: Record end times and select one candidate**

Set `_promT1=Date.now()` in `settleParallelStage` for success and failure. In `taskPromFinalize`, preserve the current singleton branch. For a multi-stage group, wait until all nodes are terminal, filter to marked `success` or `failed` tasks, select the greatest `_promT1-_promT0`, and keep array order as the tie-breaker.

Before launching the chosen background collector, mark every marked member `_promCollected=true` and the first stage `_promGroupCollected=true`. Repeated advancement and finish scans must remain idempotent while collection is in flight.

- [ ] **Step 4: Reset collection markers on retry**

When a parallel group is retried, clear `_promT0`, `_promT1`, `_promCollected`, and `_promGroupCollected` for every group member.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test projects/pipeline/tests/test_parallel_stage_execution.js projects/pipeline/tests/test_cleanup_flow.js projects/pipeline/tests/test_execution_progress.js`

Expected: PASS; a parallel group collects once and serial marked tasks still collect independently.

- [ ] **Step 6: Commit browser Prometheus de-duplication**

```bash
git add projects/pipeline/pipeline.html projects/pipeline/tests/test_parallel_stage_execution.js projects/pipeline/tests/test_cleanup_flow.js
git commit -m "feat: 合并并行任务普罗采集窗口"
```

---

### Task 5: API/schedule server parallel success path and deterministic output contract

**Files:**
- Modify: `tests/pipeline-run-api.test.mjs:360-760`
- Modify: `src/index.ts:320-365`
- Modify: `src/index.ts:1696-1890`

**Interfaces:**
- Produces: `serverPipelineStageGroups(stages: any[])` with the browser helper's `{ start, end, parallel, stages }` shape.
- Produces: `ServerStageResult = { index, stage, status, shouldStop, text, varsOut, varsPool, startedAt, endedAt, scriptName }`.
- Produces: nested `executeStage(stage,index,baseVars,signal) -> Promise<ServerStageResult>` and `recordStageResult(result,seq)`.

- [ ] **Step 1: Write failing API/schedule overlap, barrier, and variable-order tests**

Extend `loadExecPlan` with an optional `runStageScriptImpl` argument. Use deferred promises and resolve the second stage first:

```js
test('API 并行启动任务、等待汇合并按编排顺序合并输出', async () => {
  const deferred = new Map()
  const calls = []
  const runStageScript = (script, runContext, scriptsDir, varsPool) => new Promise(resolve => {
    calls.push({ name: script.name, vars: plain(varsPool) })
    deferred.set(script.name, resolve)
  })
  const f = loadExecPlan(apiExecutionConfig, {}, undefined, runStageScript)
  const plan = apiExecutionPlan([])
  plan.stages = [
    { id: 'a', name: 'A', parallel: true, script: { name: 'a.sh', path: '/a.sh', outVars: '' } },
    { id: 'b', name: 'B', parallel: true, script: { name: 'b.sh', path: '/b.sh', outVars: '' } },
    { id: 'after', name: 'After', script: { name: 'after.sh', path: '/after.sh', outVars: '' } },
  ]
  const running = f.execPlan(plan)
  await tick()
  assert.deepEqual(calls.map(call => call.name), ['a.sh', 'b.sh'])
  deferred.get('b.sh')({ code: 0, stdout: 'VALUE=b\nB=1', stderr: '' })
  await tick()
  assert.deepEqual(calls.map(call => call.name), ['a.sh', 'b.sh'])
  deferred.get('a.sh')({ code: 0, stdout: 'VALUE=a\nA=1', stderr: '' })
  await tick()
  assert.equal(calls[2].name, 'after.sh')
  assert.deepEqual(calls[2].vars, { VALUE: 'b', A: '1', B: '1' })
  deferred.get('after.sh')({ code: 0, stdout: '', stderr: '' })
  await running
  assert.equal(f.history[0].status, 'success')
})
```

Load the real `parseStageVars` into the VM fixture so this assertion exercises production output parsing.

Run the same deferred fixture once with `source:'api'` and once with `source:'schedule'`; both runs must start `a.sh` and `b.sh` before either promise resolves and must produce the same merged variables. Add a route-level assertion that a saved stage's `parallel:true` survives `buildPipelineApiRun` unchanged, and a grouping assertion that a preset stage marked `parallel:true` is still emitted as a singleton barrier.

- [ ] **Step 2: Run the API test and verify RED**

Run: `node --test --test-name-pattern="API.*并行启动任务|定时.*并行启动任务|保留 parallel" tests/pipeline-run-api.test.mjs`

Expected: FAIL because `execPlan` awaits `a.sh` before invoking `b.sh`.

- [ ] **Step 3: Extract one server stage into a result-returning function**

Move the current skip, HTTP, EvalTokens, script, missing-preset-script, and simulation branches into `executeStage`. It clones `baseVars`, captures actual start/end timestamps, and returns this concrete type without writing shared history:

```ts
type ServerStageResult = {
  index: number
  stage: any
  status: 'success' | 'failed' | 'skipped' | 'aborted'
  shouldStop: boolean
  text: string
  varsOut: Record<string, string>
  varsPool: Record<string, string>
  startedAt: number
  endedAt: number
  scriptName: string | null
}
```

For HTTP and EvalTokens, parse stdout into both the local pool and a fresh `varsOut` object, then apply their configured output mapping. For scripts, do the same with `stage.script.outVars`. Extend the nested server `applyOutVars` with an optional output sink so every key actually emitted or mapped by this stage is captured even when its value equals the upstream snapshot; do not infer outputs by comparing values. Normal task failures set `shouldStop=true`; non-blocking preset failures keep `shouldStop=false`.

- [ ] **Step 4: Coordinate batches and record in source order**

```ts
for (const group of serverPipelineStageGroups(executionStages)) {
  const groupBase = { ...varsPool }
  const controller = new AbortController()
  const results = await Promise.all(group.stages.map((stage, offset) =>
    executeStage(stage, group.start + offset, groupBase, controller.signal)))
  const blockingFailure = results.some(result => result.shouldStop)
  if (!blockingFailure) {
    for (const result of results) Object.assign(varsPool, result.varsOut)
  }
  for (const result of results) {
    await recordStageResult(result, baseSeq + result.index + 1)
  }
  if (blockingFailure) { status = 'failed'; break }
}
```

`recordStageResult` writes the unique task log and appends `logs`, `histLogs`, and `profileStages` using the original index and actual duration.

- [ ] **Step 5: Run API executor tests and verify GREEN**

Run: `node --test tests/pipeline-run-api.test.mjs`

Expected: PASS, including the new API and schedule cases plus existing HTTP/Jenkins, EvalTokens, history, and serial Prometheus tests.

- [ ] **Step 6: Commit the server success path**

```bash
git add src/index.ts tests/pipeline-run-api.test.mjs
git commit -m "feat: 并行执行服务端流水线任务"
```

---

### Task 6: Server fail-fast cancellation across scripts, fetches, polling, and simulation

**Files:**
- Modify: `tests/pipeline-run-api.test.mjs`
- Modify: `src/index.ts:446-690`
- Modify: `src/index.ts:1579-1694`
- Modify: `src/index.ts:1696-1890`

**Interfaces:**
- Consumes: `executeStage` and the batch coordinator from Task 5.
- Produces: `abortableServerSleep(ms,signal) -> Promise<void>`.
- Extends: `runStageScript(...,extraEnv?,signal?)`, `serverFetchResponse(...,maxBytes?,signal?)`, `serverFetchJson(...,signal?)`, `executeServerHttpStage(...,signal?)`, and `executeServerEvaltokensStage(...,signal?)`.

- [ ] **Step 1: Write a failing fail-fast cancellation test**

```js
test('API 并行任务失败会取消同组在途任务并阻止后续任务', async () => {
  const calls = []
  const runStageScript = (script, runContext, scriptsDir, varsPool, timeout, extraEnv, signal) =>
    new Promise(resolve => {
      calls.push(script.name)
      if (script.name === 'fail.sh') resolve({ code: 7, stdout: '', stderr: 'boom' })
      else if (script.name === 'slow.sh') {
        signal.addEventListener('abort', () =>
          resolve({ code: 1, stdout: '', stderr: 'aborted', aborted: true }), { once: true })
      } else resolve({ code: 0, stdout: '', stderr: '' })
    })
  const f = loadExecPlan(apiExecutionConfig, {}, undefined, runStageScript)
  const plan = apiExecutionPlan([])
  plan.stages = [
    { id: 'fail', name: 'Fail', parallel: true, script: { name: 'fail.sh', path: '/fail.sh' } },
    { id: 'slow', name: 'Slow', parallel: true, script: { name: 'slow.sh', path: '/slow.sh' } },
    { id: 'after', name: 'After', script: { name: 'after.sh', path: '/after.sh' } },
  ]
  await f.execPlan(plan)
  assert.deepEqual(calls, ['fail.sh', 'slow.sh'])
  assert.equal(f.history[0].status, 'failed')
  assert.deepEqual(f.history[0].logs.map(log => log.status), ['failed', 'aborted'])
})
```

- [ ] **Step 2: Run the failure test and verify RED**

Run: `node --test --test-name-pattern="API 并行任务失败" tests/pipeline-run-api.test.mjs`

Expected: FAIL because no group abort is emitted and the slow promise does not settle.

- [ ] **Step 3: Propagate the external signal**

Implement `abortableServerSleep` so timeout and abort paths remove listeners. Extend the injected sleep dependency to `(ms, signal?)` and call it with the stage signal at every Jenkins/EvalTokens polling wait. Link the external signal to `serverFetchResponse`'s deadline controller, thread it through `serverFetchJson`, and remove the listener in `finally`. Distinguish a deadline timeout from a peer-cancellation abort. Pass the signal to Node `execFile` and return `{ aborted:true }` when the callback observes `signal.aborted`.

Use this optional-argument order:

```ts
runStageScript(stage.script, runCtx, scriptsDir, localVars, stage.timeout, undefined, signal)
executeServerHttpStage(stage, runCtx, cfg, localVars, { fetchFn: globalThis.fetch, sleep: abortableServerSleep }, signal)
executeServerEvaltokensStage(stage, runCtx, cfg, localVars, { fetchFn: globalThis.fetch, sleep: abortableServerSleep }, signal)
```

- [ ] **Step 4: Abort peers on the first blocking result**

```ts
const jobs = group.stages.map((stage, offset) =>
  executeStage(stage, group.start + offset, groupBase, controller.signal).then(result => {
    if (result.shouldStop && !controller.signal.aborted) controller.abort()
    return result
  }))
const results = await Promise.all(jobs)
```

Convert group-signal cancellation to `status:'aborted'` and `shouldStop:false` so the original failure remains authoritative.

- [ ] **Step 5: Run server failure and remote-stage tests and verify GREEN**

Run: `node --test tests/pipeline-run-api.test.mjs`

Expected: PASS; failure returns, the slow peer is aborted, downstream never starts, and existing timeout/HTTP/EvalTokens behavior remains green.

- [ ] **Step 6: Commit server cancellation**

```bash
git add src/index.ts tests/pipeline-run-api.test.mjs
git commit -m "feat: 失败时取消服务端并行任务"
```

---

### Task 7: One longest Prometheus collection per server parallel group

**Files:**
- Modify: `tests/pipeline-run-api.test.mjs`
- Modify: `src/index.ts:1696-1890`

**Interfaces:**
- Consumes: ordered `ServerStageResult[]` from Task 5.
- Produces: `longestServerPromResult(results) -> ServerStageResult | null`.

- [ ] **Step 1: Write failing pure selection and API integration tests**

```js
test('服务端并行组只选择最长的合格任务采集普罗数据', () => {
  const picked = context.longestServerPromResult([
    { index: 0, stage: { promCollect: true }, status: 'success', startedAt: 1000, endedAt: 5000 },
    { index: 1, stage: { promCollect: true }, status: 'failed', startedAt: 1000, endedAt: 9000 },
    { index: 2, stage: { promCollect: true }, status: 'aborted', startedAt: 1000, endedAt: 12000 },
  ])
  assert.equal(picked.index, 1)
})
```

Add an `execPlan` fixture with two successful parallel scripts marked `promCollect:true` and configured collector `collect.py`. Resolve one task after the other, then assert exactly one collector call and that `METRICS_OUTPUT_DIR` contains the longer task's name and original two-digit stage sequence.

- [ ] **Step 2: Run Prometheus API tests and verify RED**

Run: `node --test --test-name-pattern="并行组只选择最长|勾选收集普" tests/pipeline-run-api.test.mjs`

Expected: FAIL because the helper does not exist and the current loop collects once per marked task.

- [ ] **Step 3: Select and collect once after batch settlement**

Remove Prometheus collection from `executeStage`. After a batch settles, call `longestServerPromResult`; it filters to marked `success` or `failed` tasks, selects the greatest `endedAt-startedAt`, and retains array order as the tie-breaker.

Invoke the existing collector once with the selected result's `varsPool`, timestamps, task name, and original sequence. Append the `[普罗采集]` line only to that task's log text. A singleton batch uses the same helper, preserving current serial behavior. Collection errors remain non-blocking.

- [ ] **Step 4: Run the full API executor test file and verify GREEN**

Run: `node --test tests/pipeline-run-api.test.mjs`

Expected: PASS with one collector call for a parallel group and unchanged serial collection coverage.

- [ ] **Step 5: Commit server Prometheus de-duplication**

```bash
git add src/index.ts tests/pipeline-run-api.test.mjs
git commit -m "feat: 服务端保留最长并行任务普罗数据"
```

---

### Task 8: User-facing change record, generated bundle, and complete verification

**Files:**
- Modify: `CHANGES.md:1`
- Modify: `lib/index.js`
- Modify: `lib/index.js.map`

**Interfaces:**
- Consumes: completed browser and TypeScript implementation from Tasks 1-7.
- Produces: generated server artifacts matching `src/index.ts` and a user-visible change record.

- [ ] **Step 1: Add the user-visible change entry**

Prepend one `CHANGES.md` bullet describing the editor checkbox, direct fork/join visualization, selected-task-only logs, browser/API/schedule execution, fail-fast cancellation, deterministic variable merge, whole-group retry, and single longest Prometheus capture.

- [ ] **Step 2: Run all focused tests before generation**

```bash
node --test projects/pipeline/tests/test_parallel_stage_ui.js projects/pipeline/tests/test_parallel_stage_execution.js projects/pipeline/tests/test_cleanup_flow.js projects/pipeline/tests/test_abort_token_guard.js projects/pipeline/tests/test_execution_progress.js projects/pipeline/tests/test_jenkins_stage_vars.js projects/pipeline/tests/evaltokens-stage.test.mjs
node --test tests/pipeline-run-api.test.mjs
```

Expected: both commands exit 0 with no failed, cancelled, or skipped tests.

- [ ] **Step 3: Generate and syntax-check the server bundle**

```bash
npm run build
npm run check
```

Expected: esbuild emits `lib/index.js` and `lib/client.js`; syntax checks exit 0. Confirm `lib/client.js` and its map remain unchanged because no client source changed.

- [ ] **Step 4: Run the complete repository test suite**

Run: `npm test`

Expected: root Node tests, project JavaScript tests, every Shell test, and all Python tests pass with zero failures.

- [ ] **Step 5: Audit requirements and generated diffs**

```bash
git diff --check
git status --short
git diff --stat HEAD
git diff -- src/index.ts lib/index.js
```

Confirm every spec requirement maps to a passing test, `lib/index.js` contains the generated grouping/cancellation/Prometheus logic, npm-install lockfile changes are absent from the staged set, and `.superpowers/` is not committed.

- [ ] **Step 6: Commit the change record and generated artifacts**

```bash
git add CHANGES.md lib/index.js lib/index.js.map
git commit -m "docs: 记录流水线任务并行执行"
```

- [ ] **Step 7: Re-run verification on the committed feature branch**

```bash
npm run check
npm test
git status --short --branch
```

Expected: checks and tests exit 0; only the known Visual Companion session and setup-only lockfile changes remain until cleanup.

---

### Task 9: Merge into local dev, verify the merged tree, and push

**Files:**
- No source-file changes expected.

**Interfaces:**
- Consumes: a clean, fully verified `feat/pipeline-parallel-tasks` branch.
- Produces: local and remote `dev` containing the feature commits.

- [ ] **Step 1: Stop Visual Companion and remove only its generated session**

Run:

```bash
bash /root/.codex/plugins/cache/openai-curated-remote/superpowers/6.3.0/skills/brainstorming/scripts/stop-server.sh /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks/.superpowers/brainstorm/3527461-1789096849
find /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks/.superpowers/brainstorm/3527461-1789096849 -maxdepth 3 -type f -print
```

After inspection, remove exactly `/mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks/.superpowers/brainstorm/3527461-1789096849` and empty generated parent directories. Do not touch any other brainstorm session.

```bash
rm -rf /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks/.superpowers/brainstorm/3527461-1789096849
rmdir /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks/.superpowers/brainstorm /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks/.superpowers 2>/dev/null || true
```

- [ ] **Step 2: Remove setup-only npm lock changes from the feature worktree**

Run `git diff -- package-lock.json node_modules/.package-lock.json`, then use `apply_patch` to restore only the lines changed by the initial `npm install`. Verify both files match `HEAD`. Do not touch the original checkout's uncommitted files.

- [ ] **Step 3: Integrate any dev movement into the feature branch**

```bash
git -C /mnt/data/lhf/TokensTest/dsh-plugins/tokens-worktable fetch origin
git -C /mnt/data/lhf/TokensTest/dsh-plugins/tokens-worktable status --short --branch
git -C /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks merge dev
```

If local or remote `dev` moved, integrate it without overwriting the original checkout's lockfile changes. Resolve only overlapping feature files, then repeat `npm run check && npm test` in the worktree.

- [ ] **Step 4: Merge the named feature branch into local dev**

From the main checkout, keep its existing uncommitted files intact:

```bash
git merge --no-ff feat/pipeline-parallel-tasks
```

Expected: merge succeeds without touching the original checkout's pre-existing `package-lock.json` and `node_modules/.package-lock.json` modifications.

- [ ] **Step 5: Verify the merged dev tree**

```bash
npm run check
npm test
git status --short --branch
```

Expected: checks pass; status still shows only the original checkout's pre-existing lockfile modifications, and `dev` is ahead of `origin/dev` by the feature commits.

- [ ] **Step 6: Push dev without force**

Run: `git push origin dev`

Expected: `origin/dev` advances to the verified local merge commit. If rejected because the remote moved, fetch and integrate the new remote commits, rerun merged-tree verification, and retry a normal push. Never force-push.

- [ ] **Step 7: Clean up the owned worktree and feature branch**

After the merged result is verified and pushed, remove only the owned worktree and delete the merged feature branch without force:

```bash
git -C /mnt/data/lhf/TokensTest/dsh-plugins/tokens-worktable worktree remove /mnt/data/lhf/tokens-worktable-wt/pipeline-parallel-tasks
git -C /mnt/data/lhf/TokensTest/dsh-plugins/tokens-worktable worktree prune
git -C /mnt/data/lhf/TokensTest/dsh-plugins/tokens-worktable branch -d feat/pipeline-parallel-tasks
```
