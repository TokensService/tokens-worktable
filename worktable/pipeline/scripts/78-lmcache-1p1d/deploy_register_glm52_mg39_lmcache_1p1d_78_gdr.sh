#!/usr/bin/env bash
set -euo pipefail


LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_HOST="${REMOTE_HOST:-192.168.0.78}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PASS="${REMOTE_PASS:-}"
LOG_HOST="${LOG_HOST:-192.168.0.78}"
LOG_USER="${LOG_USER:-${REMOTE_USER}}"
LOG_PASS="${LOG_PASS:-${REMOTE_PASS}}"
REMOTE_DIR="${REMOTE_DIR:-/data/wwx}"
CHART_DIR="${CHART_DIR:-/data/wwx/xds-cluster}"
RELEASE="${RELEASE:-xds-zcx-lmcache-78-glm52-mg39-1p1d-gdr}"
NAMESPACE="${NAMESPACE:-xds-zcx-lmcache-78-glm52-mg39-1p1d-gdr}"
VALUES_FILE="${VALUES_FILE:-/data/wwx/values-78-1p1d.yaml}"
XDS_URL="${XDS_URL:-http://192.168.0.78:30079/xds/v1}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
REMOTE_XDS_FOLLOW_DIR="/data/wwx/xds_head_follow_logs_${NAMESPACE}_${RUN_ID}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

remote() {
  if [[ -n "${REMOTE_PASS}" ]]; then
    sshpass -p "${REMOTE_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${REMOTE_USER}@${REMOTE_HOST}" "$@"
  else
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${REMOTE_USER}@${REMOTE_HOST}" "$@"
  fi
}

log_remote() {
  if [[ -n "${LOG_PASS}" ]]; then
    sshpass -p "${LOG_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${LOG_USER}@${LOG_HOST}" "$@"
  else
    ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${LOG_USER}@${LOG_HOST}" "$@"
  fi
}

echo ">>> local dir: ${LOCAL_DIR}"
echo ">>> remote: ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}"
echo ">>> release/namespace: ${RELEASE}/${NAMESPACE}"
echo ">>> values file: ${VALUES_FILE}"
echo ">>> chart dir: ${CHART_DIR}"
echo ">>> xds url: ${XDS_URL}"
echo ">>> log host: ${LOG_USER}@${LOG_HOST}:${REMOTE_XDS_FOLLOW_DIR}"

if [[ -n "${REMOTE_PASS}" || -n "${LOG_PASS}" ]]; then
  require_cmd sshpass
fi
echo ">>> use existing chart and values on ${REMOTE_HOST}; directory sync is disabled ..."

echo ">>> verify yaml ..."
remote "test -d '${CHART_DIR}' && test -f '${VALUES_FILE}' && helm template '${RELEASE}' '${CHART_DIR}' -n '${NAMESPACE}' -f '${VALUES_FILE}' >/tmp/${RELEASE}.rendered.yaml && grep -E 'lmcache-server|nodePort: 30079|192.168.0.78|xds-zcx-lmcache-78-glm52-mg39-1p1d-gdr|GLM-5.2' -n /tmp/${RELEASE}.rendered.yaml | head -120 || true"

echo ">>> clear and verify ACS redirect bits for GDR on ${REMOTE_HOST} ..."
remote "cd '${REMOTE_DIR}' && if [ -f clear_gdr_acs_redirect.sh ]; then chmod +x clear_gdr_acs_redirect.sh && ./clear_gdr_acs_redirect.sh && ./clear_gdr_acs_redirect.sh --check; else echo 'WARNING: clear_gdr_acs_redirect.sh is absent; skipping ACS redirect configuration.'; fi && lsmod | grep -E 'nvidia_peermem|nv_peer_mem'"

echo ">>> enable host core dump capture on ${REMOTE_HOST} ..."
remote "mkdir -p /mnt/paas/xds-core-dumps && chmod 1777 /mnt/paas/xds-core-dumps && sysctl -w fs.suid_dumpable=2 kernel.core_uses_pid=1 kernel.core_pattern='/home/service/works/models_ssd/xds-core-dumps/core.%e.%p.%t' && ulimit -c unlimited && echo core_pattern=\$(cat /proc/sys/kernel/core_pattern) && echo core_limit=\$(ulimit -c) && ls -ld /mnt/paas/xds-core-dumps"

echo ">>> clean GLM52 LMCache L1/L2 cache on ${REMOTE_HOST} ..."
remote "mkdir -p /mnt/paas/lmcache/glm52-l2/shared && find /mnt/paas/lmcache/glm52-l2/shared -mindepth 1 -maxdepth 1 -exec rm -rf {} + && find /dev/shm -maxdepth 1 -name 'lmcache_l1_pool_*' -delete && du -sh /mnt/paas/lmcache/glm52-l2/shared && df -h /dev/shm"

echo ">>> helm uninstall/install ..."
remote "cd '${REMOTE_DIR}' && mkdir -p logs && { helm uninstall '${RELEASE}' -n '${NAMESPACE}' || true; kubectl delete ns '${NAMESPACE}' --wait=true --timeout=240s || true; helm install '${RELEASE}' '${CHART_DIR}' -n '${NAMESPACE}' --create-namespace -f '${VALUES_FILE}'; } 2>&1 | tee logs/deploy_glm52_mg39_lmcache_1p1d_gdr_${RUN_ID}.log"

echo ">>> wait RayCluster ready and XDS API ready ..."
remote "for i in \$(seq 1 90); do
  state=\$(kubectl -n '${NAMESPACE}' get raycluster '${RELEASE}-kuberay' -o jsonpath='{.status.state}' 2>/dev/null || true)
  models=\$(curl --noproxy '*' -sS --connect-timeout 3 '${XDS_URL}/models/' 2>/dev/null || true)
  echo \"\$(date +%H:%M:%S) ray_state=\${state} models=\${models}\"
  if printf '%s' \"\${models}\" | grep -q '^\\['; then
    exit 0
  fi
  sleep 20
done
echo 'XDS API did not become ready in time' >&2
kubectl -n '${NAMESPACE}' get pods -o wide >&2 || true
exit 1"

echo ">>> start following XDS head pod logs on ${LOG_HOST} ..."
if [[ -n "${LOG_PASS}" ]]; then
  sshpass -p "${LOG_PASS}" scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${LOCAL_DIR}/follow_xds_head_logs.sh" "${LOG_USER}@${LOG_HOST}:/data/wwx/follow_xds_head_logs_${NAMESPACE}.sh" || true
else
  scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "${LOCAL_DIR}/follow_xds_head_logs.sh" "${LOG_USER}@${LOG_HOST}:/data/wwx/follow_xds_head_logs_${NAMESPACE}.sh" || true
fi
log_remote "set -e; chmod +x '/data/wwx/follow_xds_head_logs_${NAMESPACE}.sh'; mkdir -p '${REMOTE_XDS_FOLLOW_DIR}'; cd '${REMOTE_XDS_FOLLOW_DIR}'; nohup env OUT='${REMOTE_XDS_FOLLOW_DIR}' bash '/data/wwx/follow_xds_head_logs_${NAMESPACE}.sh' '${NAMESPACE}' > follow_launcher.log 2>&1 < /dev/null & echo \\\$! > launcher.pid" || true

echo ">>> register GLM-5.2 NVFP4 lmcache l2 1P1D model ..."
remote "cd '${REMOTE_DIR}' && mkdir -p logs && XDS_URL='${XDS_URL}' bash register_glm52_mg39_lmcache_1p1d_78_gdr.sh 2>&1 | tee logs/register_glm52_mg39_lmcache_1p1d_gdr_${RUN_ID}.log"

echo ">>> wait model ACTIVE ..."
remote "for i in \$(seq 1 120); do
  raw=\$(curl --noproxy '*' -sS --connect-timeout 3 '${XDS_URL}/models/' 2>&1 || true)
  echo \"===\$(date +%H:%M:%S)===\"
  printf '%s\n' \"\${raw}\"
  status=\$(printf '%s' \"\${raw}\" | grep -o '\"status\":\"[A-Z]*\"' | head -1 | cut -d'\"' -f4)
  if [ \"\${status}\" = ACTIVE ]; then
    exit 0
  fi
  if [ \"\${status}\" = ERROR ] || [ \"\${status}\" = FAILED ]; then
    exit 2
  fi
  sleep 30
done
echo 'model did not become ACTIVE in time' >&2
exit 1"

echo ">>> final status ..."
remote "curl --noproxy '*' -sS '${XDS_URL}/models/' | python3 -m json.tool; kubectl -n '${NAMESPACE}' get pods -o wide"

echo ">>> done"
