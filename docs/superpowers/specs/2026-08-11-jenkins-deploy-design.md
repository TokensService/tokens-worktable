# Jenkins Deployment Design

## Goal

Build the first usable slice of the automated profiling tool: deploy or uninstall a model by calling the existing Jenkins job, then expose that flow as LangGraph nodes for later profiling stages.

## Scope

This change covers Jenkins-backed environment deployment only. It does not implement model profiling, benchmark execution, result parsing, or persistence.

## Architecture

The implementation uses three small layers:

- `op_test.jenkins.client`: pure Jenkins HTTP API wrapper using `httpx`, Basic Auth, cached CSRF crumb, queue lookup, build status, logs, stage view, stop, and GPU status.
- `op_test.deploy.params`: request dataclasses and helpers that translate deployment and uninstall intent into Jenkins build parameters.
- `op_test.graph.deploy`: LangGraph-compatible state functions and a small graph factory for submit, resolve build number, and refresh deployment status.

Jenkins credentials and job settings default to the documented internal values, but can be overridden by environment variables or explicit `JenkinsConfig` values.

## Data Flow

Deploy flow:

1. Caller creates a `DeployRequest`.
2. `build_deploy_params()` converts it into Jenkins form fields.
3. `submit_deploy_node()` submits `/buildWithParameters` and stores `queue_id`.
4. `resolve_build_number_node()` reads the Jenkins queue item and stores `build_number` once available.
5. `refresh_build_status_node()` fetches build info, stage view, and live log URL.

Uninstall flow:

1. Caller creates an `UninstallRequest` with the source deployment build number.
2. `build_uninstall_params()` creates the Jenkins uninstall form fields.
3. The same submit and polling client primitives are reused.

## Error Handling

The client raises `httpx.HTTPStatusError` for Jenkins HTTP failures. Queue cancellation raises `RuntimeError`, missing queue/build identifiers in graph state raises `ValueError`, and timeout helpers raise `TimeoutError`.

## Testing

Tests use a fake `httpx.MockTransport` so no test calls the internal Jenkins service. Coverage focuses on observable contracts: exact Jenkins parameter payloads, crumb retry behavior, queue/build parsing, progressive log offsets, and LangGraph state updates.
