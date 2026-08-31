# Pipeline scripts

`pipeline.sh` is the preparation entry point. It runs, in order:

1. `pull-image.sh`: pre-pulls `IMAGE_NAME` into the local and target
   Kubernetes/containerd image caches, then exports the chart, values, and
   architecture templates from `TEMPLATE_IMAGE` into `RUN_DIR/template`.
2. `render-config.sh`: renders the Helm chart, values file, architecture
   request, and rendered P/D resource manifest.

All pipeline configuration is supplied through environment variables. None of
the stage scripts accepts a deployment argument.

Required for `pipeline.sh`:

```bash
export IMAGE_NAME='registry.example/xds:tag'
export ARCH_NAME='glm-5.2-nvfp4'
export TARGET_HOSTS='[{"ip":"192.168.0.128","user":"root"}]'
export TARGET_PASSWORD='...'
export REGISTRY_SECRET_NAMESPACE='...'
export REGISTRY_SECRET_NAME='...'
bash pipeline.sh
```

Optional environment variables include `RUN_DIR`, `DEPLOY_IMAGE`,
`PIPELINE_NAME`, `NUM_PREFILL`, `NUM_DECODE`, `PREFILL_GPU`, `DECODE_GPU`,
`NAMESPACE`, and `RELEASE_NAME`. `pipeline.sh` prints the rendered contract as
`KEY=VALUE` lines for the later `deploy-model.sh`, `register-model.sh`, and
`model-health.sh` stages.

`TEMPLATE_IMAGE` defaults to `IMAGE_NAME`. Set it to the image that carries
`/opt/op_test/xds_template` when the deployment image is a runtime-only image.
Alternatively, set `CHART_TEMPLATE_DIR`, `VALUES_TEMPLATE`, and `ARCH_FILE`
together to bypass template-image export.
