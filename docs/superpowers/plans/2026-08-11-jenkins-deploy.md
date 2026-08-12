# Jenkins Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Jenkins-backed model deployment as the first LangGraph stage of the automated profiling tool.

**Architecture:** Create a small Python package with a pure Jenkins HTTP client, deployment parameter builders, and LangGraph node functions. Tests use `httpx.MockTransport` and exercise behavior without connecting to Jenkins.

**Tech Stack:** Python 3.11+, `httpx`, `langgraph`, `pytest`.

## Global Constraints

- Jenkins URL defaults to `http://10.112.32.240:28080`.
- Jenkins user defaults to `admin`.
- Jenkins password defaults to `XDS@2025`.
- Jenkins job defaults to `xds-local-deploy`.
- POST requests fetch and send Jenkins crumb headers, then retry once on HTTP 403.
- Tests must not call the real Jenkins service.

---

### Task 1: Project Skeleton and Dependencies

**Files:**
- Create: `pyproject.toml`
- Create: `op_test/__init__.py`
- Create: `op_test/jenkins/__init__.py`
- Create: `op_test/deploy/__init__.py`
- Create: `op_test/graph/__init__.py`

**Interfaces:**
- Produces: installable Python package `op_test`.
- Produces: test command `pytest`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_package_imports.py`:

```python
def test_package_imports():
    import op_test

    assert op_test.__version__ == "0.1.0"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_package_imports.py -v`
Expected: FAIL because `op_test` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `pyproject.toml` with package metadata and dependencies:

```toml
[project]
name = "op-test"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "httpx>=0.27",
  "langgraph>=0.2",
]

[project.optional-dependencies]
test = [
  "pytest>=8",
]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]
```

Create `op_test/__init__.py`:

```python
__version__ = "0.1.0"
```

Create empty package markers for `op_test/jenkins`, `op_test/deploy`, and `op_test/graph`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_package_imports.py -v`
Expected: PASS.

### Task 2: Jenkins Parameter Builders

**Files:**
- Create: `op_test/deploy/params.py`
- Create: `tests/test_deploy_params.py`

**Interfaces:**
- Produces: `DeployRequest`, `UninstallRequest`, `build_deploy_params(request: DeployRequest) -> dict[str, str]`, `build_uninstall_params(request: UninstallRequest) -> dict[str, str]`.

- [ ] **Step 1: Write the failing tests**

Tests cover deploy IP normalization, optional fields, and uninstall build tag generation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_deploy_params.py -v`
Expected: FAIL because `op_test.deploy.params` does not exist.

- [ ] **Step 3: Write minimal implementation**

Use dataclasses. Default deploy `PIPELINE_STEPS` to `"true," * 16`; default uninstall `PIPELINE_STEPS` to `"uninstall"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_deploy_params.py -v`
Expected: PASS.

### Task 3: Jenkins HTTP Client

**Files:**
- Create: `op_test/jenkins/client.py`
- Create: `tests/test_jenkins_client.py`

**Interfaces:**
- Produces: `JenkinsConfig.from_env()`, `JenkinsClient.submit_build()`, `get_queue_item()`, `get_build_info()`, `get_stage_view()`, `get_console_text()`, `get_progressive_log()`, `stop_build()`, `get_node_gpu_status()`, `get_live_log_url()`.

- [ ] **Step 1: Write the failing tests**

Tests use `httpx.MockTransport` and verify crumb injection/retry, queue id extraction, build info query, progressive log offset parsing, and live log URL.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_jenkins_client.py -v`
Expected: FAIL because `op_test.jenkins.client` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement the documented Jenkins API wrapper and allow an injected `httpx.Client` for tests.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_jenkins_client.py -v`
Expected: PASS.

### Task 4: LangGraph Deployment Nodes

**Files:**
- Create: `op_test/graph/deploy.py`
- Create: `tests/test_deploy_graph.py`

**Interfaces:**
- Produces: `DeploymentState`, `submit_deploy_node(state)`, `resolve_build_number_node(state)`, `refresh_build_status_node(state)`, `create_deploy_graph()`.

- [ ] **Step 1: Write the failing tests**

Tests call node functions with a fake client and verify returned state updates for submit, queue resolution, cancellation, and status refresh.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_deploy_graph.py -v`
Expected: FAIL because `op_test.graph.deploy` does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement node functions as pure state transforms. `create_deploy_graph()` returns a compiled `StateGraph` with submit, resolve, and refresh nodes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_deploy_graph.py -v`
Expected: PASS.

### Task 5: Documentation and Full Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: all public APIs from Tasks 1-4.
- Produces: short usage examples for deploy, uninstall, GPU status, and graph invocation.

- [ ] **Step 1: Update README**

Document installation, environment variables, and minimal usage snippets.

- [ ] **Step 2: Run full test suite**

Run: `pytest -v`
Expected: PASS.

- [ ] **Step 3: Inspect git diff**

Run: `git diff --stat`
Expected: only package, tests, docs, and project metadata changed.

## Self-Review

- Spec coverage: deployment submit, uninstall submit, queue lookup, build status, stage view, logs, stop, GPU status, and live log URL are covered by the tasks.
- Placeholder scan: no `TBD`, `TODO`, or unspecified implementation steps remain.
- Type consistency: dataclass and function names match between tasks.
