# Pipeline scripts

`pull_render_config.sh` is the preparation entry point. It runs, in order:

1. `pull-image.sh`: pulls `IMAGE_NAME` into the pipeline execution host's
   Kubernetes/containerd image cache, then exports the chart, values, and
   architecture templates from `TEMPLATE_IMAGE` into `RUN_DIR/template`.
2. `render-config.sh`: renders the Helm chart, values file, architecture
   request, and rendered P/D resource manifest on the pipeline execution host.
3. `pull_render_config.sh`: synchronizes the rendered directory and target
   `pipeline.env` to every `TARGET_HOSTS` entry. The default target path is
   `/tmp/op-test-pipeline/<PIPELINE_NAME>/rendered`.

All pipeline configuration is supplied through environment variables. None of
the stage scripts accepts a deployment argument.

`pull_render_config.sh` reads all configuration from environment variables. They are optional; unset values use the script defaults.

```bash
export IMAGE_NAME='registry.example/xds:tag'
export ARCH_NAME='glm-5.2-nvfp4'
export TARGET_HOSTS='[{"ip":"<target-host-ip>","user":"root"}]'
export TARGET_PASSWORD='...'
bash pull_render_config.sh
```

Optional environment variables include `RUN_DIR`, `DEPLOY_IMAGE`,
`PIPELINE_NAME`, `NUM_PREFILL`, `NUM_DECODE`, `PREFILL_GPU`, `DECODE_GPU`,
`NAMESPACE`, and `RELEASE_NAME`. `pull_render_config.sh` prints the rendered contract as
`KEY=VALUE` lines for the later `deploy-model.sh`, `register-model.sh`, and
`model-health.sh` stages.

`TEMPLATE_IMAGE` defaults to `IMAGE_NAME`. Set it to the image that carries
`/opt/op_test/xds_template` when the deployment image is a runtime-only image.
Alternatively, set `CHART_TEMPLATE_DIR`, `VALUES_TEMPLATE`, and `ARCH_FILE`
together to bypass template-image export.

`TEMPLATE_VARS_JSON` supplies the non-derived placeholders in the values
template, such as database settings, service ports, and the task-executor node
label. `DEPLOY_NAMESPACE` and `IMAGE_TAG` are derived automatically. Rendering
fails before YAML parsing if any other `{UPPER_CASE_PLACEHOLDER}` is unresolved.
