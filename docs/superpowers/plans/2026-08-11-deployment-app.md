# Deployment App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the non-profiling application layer: deployment orchestration, CLI, REST API, and a single-screen web UI.

**Architecture:** Keep Jenkins access in `op_test.jenkins.client`, add a service layer in `op_test.service.orchestrator` for polling and auto-uninstall decisions, expose it through FastAPI in `op_test.api.app`, and provide static HTML/CSS/JS under `op_test/web/static`. CLI commands call the same service layer, so frontend and terminal behavior share one implementation.

**Tech Stack:** Python 3.11+, `httpx`, `langgraph`, `fastapi`, `uvicorn`, `pytest`, static HTML/CSS/JavaScript.

## Global Constraints

- Profiling is out of scope.
- The UI first screen is the operational tool, not a landing page.
- Tests must not call the real Jenkins service.
- The service layer must support deploy, uninstall, status, logs, GPU status, GPU candidate selection, wait-for-build-number, wait-for-completion, and optional auto-uninstall on failed deploy.
- The API must allow dependency injection for tests so fake clients can be used.

---

### Task 1: Service Orchestrator

**Files:**
- Create: `op_test/service/__init__.py`
- Create: `op_test/service/orchestrator.py`
- Test: `tests/test_orchestrator.py`

**Interfaces:**
- Produces: `DeploymentOrchestrator`.
- Produces: `BuildSummary`.
- Produces: methods `submit_deploy()`, `submit_uninstall()`, `wait_for_build_number()`, `wait_for_completion()`, `deploy_and_wait()`, `uninstall_and_wait()`, `get_status()`, `get_logs()`, `get_gpu_status()`, `select_gpu_nodes()`.

- [ ] **Step 1: Write failing tests**

Create tests with a fake Jenkins client. Verify node selection, deploy wait flow, progressive logs, and auto-uninstall on failure.

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/test_orchestrator.py -v`
Expected: FAIL because `op_test.service.orchestrator` does not exist.

- [ ] **Step 3: Implement service layer**

Use small synchronous polling loops with configurable interval and timeout. In tests, pass `poll_interval=0`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/test_orchestrator.py -v`
Expected: PASS.

### Task 2: CLI

**Files:**
- Create: `op_test/cli.py`
- Modify: `pyproject.toml`
- Test: `tests/test_cli.py`

**Interfaces:**
- Produces console script `op-test`.
- Produces CLI subcommands `deploy`, `uninstall`, `status`, `logs`, `gpu`.

- [ ] **Step 1: Write failing tests**

Test argument parsing with injected fake orchestrator factory and JSON output.

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/test_cli.py -v`
Expected: FAIL because `op_test.cli` does not exist.

- [ ] **Step 3: Implement CLI**

Use `argparse`, output JSON for machine-readable use, and keep command functions testable through `main(argv, orchestrator_factory=...)`.

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/test_cli.py -v`
Expected: PASS.

### Task 3: FastAPI API and Static Frontend

**Files:**
- Create: `op_test/api/__init__.py`
- Create: `op_test/api/app.py`
- Create: `op_test/web/static/index.html`
- Create: `op_test/web/static/styles.css`
- Create: `op_test/web/static/app.js`
- Modify: `pyproject.toml`
- Test: `tests/test_api.py`

**Interfaces:**
- Produces: `create_app(orchestrator_factory=None)`.
- Produces API endpoints `GET /api/gpu`, `POST /api/deploy`, `POST /api/uninstall`, `GET /api/builds/{build_number}`, `GET /api/builds/{build_number}/logs`.
- Produces static web UI at `/`.

- [ ] **Step 1: Write failing tests**

Use FastAPI `TestClient` with fake orchestrator factory. Verify deploy, uninstall, status, logs, GPU response, and root page.

- [ ] **Step 2: Run tests to verify failure**

Run: `pytest tests/test_api.py -v`
Expected: FAIL because `op_test.api.app` does not exist.

- [ ] **Step 3: Implement API and web UI**

Serve static files from package path. UI calls API endpoints with `fetch`, renders GPU nodes, stages, live log URL, and logs.

- [ ] **Step 4: Run tests to verify pass**

Run: `pytest tests/test_api.py -v`
Expected: PASS.

### Task 4: Complete Graph and Docs

**Files:**
- Modify: `op_test/graph/deploy.py`
- Modify: `README.md`
- Test: `tests/test_deploy_graph.py`

**Interfaces:**
- Produces graph node helpers for wait/refresh completion-oriented deploy state.
- Documents CLI and web server usage.

- [ ] **Step 1: Extend tests**

Verify graph can call the service-level wait behavior through state without real Jenkins.

- [ ] **Step 2: Implement graph additions**

Add nodes that delegate to `DeploymentOrchestrator` while keeping existing nodes stable.

- [ ] **Step 3: Update README**

Document `op-test serve`, CLI commands, and the web UI.

- [ ] **Step 4: Run full suite**

Run: `pytest -v`
Expected: PASS.

## Self-Review

- Spec coverage: orchestration, CLI, API, static UI, GPU selection, uninstall, logs, and deployment status are covered.
- Placeholder scan: no open-ended placeholders remain.
- Type consistency: method and endpoint names are defined before use.
