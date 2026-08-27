#!/usr/bin/env bash
set -euo pipefail

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY 2>/dev/null || true

XDS_URL="${XDS_URL:-http://192.168.0.78:30079/xds/v1}"
MODEL_NAME="${MODEL_NAME:-glm-5.2-nvfp4}"
MODEL_PATH="${MODEL_PATH:-/home/service/works/models_ssd/GLM-5.2-NVFP4-W4A4-MG39-BNT3/v1}"
CURL="curl --noproxy '*' -sS"

echo ">>> register architecture ${MODEL_NAME} with lmcache enabled, offloading disabled, sync register-kv-cache and speculative disabled ..."
${CURL} -X POST "${XDS_URL}/models/architectures" \
  -H 'Content-Type: application/json' \
  --data-raw "{
    \"arch_name\": \"${MODEL_NAME}\",
    \"model_family\": \"deepseek_v3_npu\",
    \"engine_type\": \"vllm\",
    \"deploy_spec_packages\": [
      {
        \"spec_package_name\": \"${MODEL_NAME}\",
        \"deploy_specs\": [
          {
            \"name\": \"prefill\",
            \"role\": \"prefill\",
            \"params\": {
              \"tensor_parallel_size\": 1,
              \"pipeline_parallel_size\": 4,
              \"pp_layer_partition\": \"22,20,20,16\",
              \"data_parallel_size\": 1,
              \"data_parallel_backend\": \"ray\",
              \"distributed_executor_backend\": \"mp\",
              \"async_scheduling\": false,
              \"max_model_len\": 524288,
              \"max_input_tokens\": 524288,
              \"enable_prefix_caching\": true,
              \"enable_expert_parallel\": false,
              \"max_num_seqs\": 8,
              \"max_num_batched_tokens\": 8192,
              \"reasoning_tokens_upper_bound\": 65536,
              \"max_tokens_upper_bound\": 131072,
              \"output_tokens_upper_bound\": 131072,
              \"use_python_encode\": false,
              \"ts_model\": \"Default\",
              \"dp_strategy_type\": \"max_time\",
              \"dp_strategy_sp_type\": \"max_time\",
              \"dp_strategy_ems_type\": \"max_time\",
              \"dp_strategy_sp_ems_type\": \"max_time\",
              \"ts_batching_strategy\": \"PROMPT_HASH_AFFINITY\",
              \"ts_pha_affinity_strategy\": \"TRIE_PREFIX\",
              \"ts_pha_trie_max_nodes\": 3000000,
              \"ts_pha_trie_limit_nodes\": 1500000,
              \"ts_prefix_match_balance_abs_threshold\": 8,
              \"ts_prefix_match_balance_rel_threshold\": 6,
              \"ts_pha_balance_strategy\": \"QUEUE_LEN_BALANCED\",
              \"use_single_batch_schedule\": true,
              \"affinity_schedule_strategy\": \"radix_tree\",
              \"tool_parser\": \"glm47\",
              \"reasoning_parser\": \"glm45\",
              \"ttft_timeout_seconds\": 3000,
              \"enable_auto_tools\": true,
              \"use_vllm_offloading\": false,
              \"use_lmcache\": true,
              \"lmcache_mp_host\": \"tcp://192.168.0.78\",
              \"lmcache_mp_port\": 5555,
              \"lmcache_mp_mq_timeout\": 1200.0,
              \"use_ems\": false,
              \"compilation_config\": {\"cudagraph_mode\": \"None\"},
              \"kernel_config\": {\"enable_flashinfer_autotune\": false},
              \"gpu_memory_utilization\": 0.9,
              \"kv_cache_dtype\": \"fp8\",
              \"xccl_turbo_sync_sparse_indexer\": true,
              \"xccl_turbo_fix_native_cpu_offload_pin\": false,
              \"xds_pte_max_inflight\": 512
            },
            \"resources\": [
              {\"device_type\": \"BNT3\", \"cpu\": 48, \"gpu\": 4, \"memory\": \"200G\"}
            ],
            \"min\": 1,
            \"max\": 1,
            \"default\": 1
          },
          {
            \"name\": \"decode\",
            \"role\": \"decode\",
            \"params\": {
              \"tensor_parallel_size\": 1,
              \"data_parallel_size\": 4,
              \"data_parallel_backend\": \"ray\",
              \"distributed_executor_backend\": \"mp\",
              \"async_scheduling\": true,
              \"max_model_len\": 524288,
              \"max_input_tokens\": 524288,
              \"enable_prefix_caching\": true,
              \"enable_expert_parallel\": false,
              \"max_num_seqs\": 32,
              \"max_num_batched_tokens\": 64,
              \"use_python_encode\": false,
              \"tool_parser\": \"glm47\",
              \"reasoning_parser\": \"glm45\",
              \"enable_auto_tools\": true,
              \"compilation_config\": {
                \"cudagraph_mode\": \"FULL_DECODE_ONLY\",
                \"cudagraph_capture_sizes\": [12, 16, 24, 32]
              },
              \"kernel_config\": {\"enable_flashinfer_autotune\": false},
              \"gpu_memory_utilization\": 0.9,
              \"kv_cache_dtype\": \"fp8\"
            },
            \"resources\": [
              {\"device_type\": \"BNT3\", \"cpu\": 48, \"gpu\": 4, \"memory\": \"200G\"}
            ],
            \"min\": 1,
            \"max\": 1,
            \"default\": 1
          }
        ]
      }
    ]
  }"
echo

echo ">>> register model ${MODEL_NAME} ..."
${CURL} -X POST "${XDS_URL}/models/" \
  -H 'Content-Type: application/json' \
  --data-raw "{
    \"model\": \"${MODEL_NAME}\",
    \"model_endpoint\": \"${MODEL_NAME}\",
    \"arch_name\": \"${MODEL_NAME}\",
    \"version\": \"v1\",
    \"max_instance\": 1,
    \"min_instance\": 1,
    \"location\": \"local\",
    \"spec_package\": \"${MODEL_NAME}\",
    \"local_info\": {\"path\": \"${MODEL_PATH}\"},
    \"resource_list\": [
      {\"resource_id\": \"glm52-prefill-78\", \"resource_type\": \"prefill\", \"resource_status\": \"IDLE\", \"resource_bundles\": [\"127.0.0.1\"]},
      {\"resource_id\": \"glm52-decode-78\", \"resource_type\": \"decode\", \"resource_status\": \"IDLE\", \"resource_bundles\": [\"127.0.0.5\"]}
    ]
  }"
echo

echo ">>> current models:"
${CURL} "${XDS_URL}/models/"
echo
