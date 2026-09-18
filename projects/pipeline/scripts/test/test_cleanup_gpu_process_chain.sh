#!/usr/bin/env bash
set -euo pipefail

script="$(cd "$(dirname "$0")/.." && pwd)/cleanup-env.sh"
tmp=$(mktemp -d)
launcher_pid=''
cleanup() {
    if [[ -n "$launcher_pid" ]]; then
        kill -KILL -- "-$launcher_pid" 2>/dev/null || true
    fi
    rm -rf "$tmp"
}
trap cleanup EXIT

# 使用独立进程组模拟“启动脚本 -> GPU Worker”，验证清理入口会终止整个
# 宿主启动链，而不是只终止 nvidia-smi 返回的叶子进程。
setsid bash -c 'sleep 300 & wait' &
launcher_pid=$!
for _ in $(seq 1 20); do
    worker_pid=$(pgrep -P "$launcher_pid" sleep 2>/dev/null | head -n1 || true)
    [[ -n "$worker_pid" ]] && break
    sleep 0.1
done
[[ -n "${worker_pid:-}" ]] || { echo '无法创建模拟 GPU 进程链' >&2; exit 1; }

source <(sed '/^main "\$@"$/d' "$script")
LOG_FILE="$tmp/cleanup.log"
DRY_RUN=0

do_kill_host_chain "$worker_pid"

process_is_live() {
    local state
    state=$(ps -o stat= -p "$1" 2>/dev/null | awk '{print $1}')
    [[ -n "$state" && "$state" != Z* ]]
}
if process_is_live "$launcher_pid" || process_is_live "$worker_pid"; then
    echo '宿主 GPU 启动进程组未被完整终止' >&2
    exit 1
fi
grep -Fq "宿主进程链:" "$LOG_FILE"
grep -Fq "进程组 PGID=$launcher_pid" "$LOG_FILE"
if grep -Fq 'SIGKILL' "$LOG_FILE"; then
    echo '只剩 zombie 时不应升级为 SIGKILL' >&2
    exit 1
fi

echo 'PASS: GPU cleanup logs and terminates the complete host process group'
