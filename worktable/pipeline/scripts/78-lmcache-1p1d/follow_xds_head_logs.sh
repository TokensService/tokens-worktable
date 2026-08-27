#!/usr/bin/env bash
set -euo pipefail

NS="${1:-${NS:-xds-zcx-lmcache-78-glm52-mg39-1p1d-gdr}}"
BASE_DIR="${BASE_DIR:-/data/wwx}"
RUN_ID="${RUN_ID:-$(date +%Y%m%d_%H%M%S)}"
OUT="${OUT:-${BASE_DIR}/xds_head_follow_logs_${NS}_${RUN_ID}}"
PID_FILE="${PID_FILE:-${OUT}/follow.pid}"

mkdir -p "${OUT}"

head_pod=$(kubectl -n "${NS}" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep 'kuberay-head' | head -1 || true)
if [ -z "${head_pod}" ]; then
  echo "head pod not found in namespace ${NS}" | tee "${OUT}/error.txt"
  exit 1
fi

containers=$(kubectl -n "${NS}" get pod "${head_pod}" -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}' 2>/dev/null || true)
if [ -z "${containers}" ]; then
  echo "no containers found in head pod ${head_pod}" | tee "${OUT}/error.txt"
  exit 1
fi

lmcache_pods=$(kubectl -n "${NS}" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null | grep -E '^lmcache-server' || true)
worker_pods=$(kubectl -n "${NS}" get pods -l 'ray.io/node-type=worker' -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)

{
  echo "namespace=${NS}"
  echo "head_pod=${head_pod}"
  echo "containers=$(printf "%s " ${containers})"
  echo "lmcache_pods=${lmcache_pods:-}"
  echo "worker_pods=${worker_pods:-}"
  echo "output_dir=${OUT}"
  echo "started_at=$(date +%F_%T)"
} > "${OUT}/summary.txt"

kubectl -n "${NS}" get pod "${head_pod}" -o wide > "${OUT}/head_pod.txt" 2>&1 || true
kubectl -n "${NS}" get pod "${head_pod}" -o yaml > "${OUT}/head_pod.yaml" 2>&1 || true

main_pid=$$
echo "${main_pid}" > "${PID_FILE}"

child_pids=()
cleanup() {
  for pid in "${child_pids[@]:-}"; do
    kill "${pid}" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
  echo "stopped_at=$(date +%F_%T)" >> "${OUT}/summary.txt"
}
trap cleanup EXIT INT TERM

for c in ${containers}; do
  log_file="${OUT}/head_${c}.follow.log"
  (
    echo "===== follow ${head_pod}/${c} started_at=$(date +%F_%T) ====="
    kubectl -n "${NS}" logs -f "${head_pod}" -c "${c}" --tail=-1
    rc=$?
    echo "===== follow ${head_pod}/${c} exited_at=$(date +%F_%T) rc=${rc} ====="
    exit "${rc}"
  ) > "${log_file}" 2>&1 &
  child_pids+=("$!")
done

if [ -n "${lmcache_pods}" ]; then
  mkdir -p "${OUT}/lmcache"
  for pod in ${lmcache_pods}; do
    pod_dir="${OUT}/lmcache/${pod}"
    mkdir -p "${pod_dir}"
    kubectl -n "${NS}" get pod "${pod}" -o wide > "${pod_dir}/pod.txt" 2>&1 || true
    kubectl -n "${NS}" get pod "${pod}" -o yaml > "${pod_dir}/pod.yaml" 2>&1 || true
    pod_containers=$(kubectl -n "${NS}" get pod "${pod}" -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}' 2>/dev/null || true)
    for c in ${pod_containers}; do
      log_file="${pod_dir}/${c}.follow.log"
      (
        echo "===== follow ${pod}/${c} started_at=$(date +%F_%T) ====="
        kubectl -n "${NS}" logs -f "${pod}" -c "${c}" --tail=-1
        rc=$?
        echo "===== follow ${pod}/${c} exited_at=$(date +%F_%T) rc=${rc} ====="
        exit "${rc}"
      ) > "${log_file}" 2>&1 &
      child_pids+=("$!")
    done
  done
fi

if [ -n "${worker_pods}" ]; then
  mkdir -p "${OUT}/workers"
  for pod in ${worker_pods}; do
    pod_dir="${OUT}/workers/${pod}"
    mkdir -p "${pod_dir}"
    kubectl -n "${NS}" get pod "${pod}" -o wide > "${pod_dir}/pod.txt" 2>&1 || true
    kubectl -n "${NS}" get pod "${pod}" -o yaml > "${pod_dir}/pod.yaml" 2>&1 || true
    pod_containers=$(kubectl -n "${NS}" get pod "${pod}" -o jsonpath='{range .spec.containers[*]}{.name}{"\n"}{end}' 2>/dev/null || true)
    for c in ${pod_containers}; do
      log_file="${pod_dir}/${c}.follow.log"
      (
        echo "===== follow ${pod}/${c} started_at=$(date +%F_%T) ====="
        kubectl -n "${NS}" logs -f "${pod}" -c "${c}" --tail=-1
        rc=$?
        echo "===== follow ${pod}/${c} exited_at=$(date +%F_%T) rc=${rc} ====="
        exit "${rc}"
      ) > "${log_file}" 2>&1 &
      child_pids+=("$!")
    done
  done
fi

wait
