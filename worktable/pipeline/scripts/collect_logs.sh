#!/usr/bin/env bash
# 归档脚本：流水线运行结束、写完 run-<tag>.log/.profile.json 后执行，
# 收集节点/系统等额外日志。失败不影响运行结果（页面会 console.warn 跳过）。
#
# 落盘约定：host 日志（<ip>.log / controller.log）是节点环境日志，与单次运行无关，
# 写到归档路径根目录（ARCHIVE_DIR，跨运行共享，同名覆盖为最新环境快照）；
# pod 日志等与本次运行相关的产物仍写进本次运行的归档文件夹（ARCHIVE_FOLDER）。
#
# 在「设置 → 归档配置 → 归档脚本」配置（默认 collect_logs.sh，留空=不执行）；
# 脚本不存在时页面自动跳过，本脚本可按需删改。
#
# 注入的环境变量（归档脚本专用，见 README「归档与 AI 分析」）：
#   ARCHIVE_DIR           归档根目录（host 节点环境日志写到此处）
#   ARCHIVE_FOLDER        本次运行的归档文件夹（绝对路径；run-<tag>.log/.profile.json 已在其中）
#   ARCHIVE_LOG_FILE      归档内 run-<tag>.log 绝对路径
#   ARCHIVE_PROFILE_FILE  归档内 run-<tag>.profile.json 绝对路径
#   ARCHIVE_PIPELINE      流水线名
#   ARCHIVE_TAG           本次运行 tag
#   ARCHIVE_RESULT        运行结果（success/failed/aborted）
# 另含流水线通用注入：TARGET_IP/TARGET_IPS/TARGET_HOSTS/TARGET_USER/TARGET_PASSWORD/
#   IMAGE_NAME/IMAGE_TAG/PIPELINE_NAME/GIT_*（见 README「自动注入的环境变量」）
set +e   # 收集脚本：单项失败不应中断整体归档（与模板的 set -e 不同，此处刻意放宽）

ARCHIVE_FOLDER="${ARCHIVE_FOLDER:-}"
# host 日志落根目录；旧版页面未注入 ARCHIVE_DIR（或注入的是运行文件夹）时回退 ARCHIVE_FOLDER，保持原行为
ARCHIVE_DIR="${ARCHIVE_DIR:-$ARCHIVE_FOLDER}"
PIPELINE_NAME="${PIPELINE_NAME:-unknown}"
ARCHIVE_TAG="${ARCHIVE_TAG:-notag}"
ARCHIVE_RESULT="${ARCHIVE_RESULT:-unknown}"
TARGET_IP="${TARGET_IP:-127.0.0.1}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_PASSWORD="${TARGET_PASSWORD:-}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"

echo "[collect_logs] pipeline=$PIPELINE_NAME tag=$ARCHIVE_TAG result=$ARCHIVE_RESULT"

# 主控未填「归档路径」时页面不会进入归档流程，此处再兜底一次
if [ -z "$ARCHIVE_FOLDER" ]; then
  echo "[collect_logs] ARCHIVE_FOLDER 为空，跳过"
  exit 0
fi

stamp() { date '+%Y-%m-%dT%H:%M:%S%z'; }

# 收集单个节点日志到 ARCHIVE_DIR/<ip>.log（归档路径根目录：节点环境日志跨运行共享，同名覆盖为最新快照）
collect_one() {   # $1=ip $2=user $3=pass
  local ip="$1" user="$2" pass="$3"
  local safe; safe=$(printf '%s' "$ip" | tr -c 'A-Za-z0-9.-' '_')
  local out="$ARCHIVE_DIR/${safe}.log"
  echo "[collect_logs] -> host $user@$ip -> $out"
  local remote='echo "### uname"; uname -a; '
  remote+='echo "### uptime"; uptime; '
  remote+='echo "### dmesg tail"; (dmesg --time-format iso 2>/dev/null || dmesg 2>/dev/null) | tail -n 200; '
  remote+='echo "### journalctl tail"; (journalctl -n 500 --no-pager 2>/dev/null || true); '
  remote+='echo "### nvidia-smi"; (nvidia-smi 2>/dev/null || echo "no nvidia-smi"); '
  remote+='echo "### docker ps"; (docker ps -a 2>/dev/null || true)'
  {
    echo "===== host $user@$ip @ $(stamp) ====="
    if command -v sshpass >/dev/null 2>&1 && [ -n "$pass" ]; then
      sshpass -p "$pass" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=8 "$user@$ip" "$remote" 2>&1
    else
      echo "(无 sshpass 或密码，跳过远程采集；可配 ssh 免密或安装 sshpass)"
    fi
  } >"$out" 2>&1
}

# 多节点遍历（各自凭据）：TARGET_HOSTS 是 [{ip,user,pass}] JSON 数组
handled=0
if command -v python3 >/dev/null 2>&1; then
  while IFS=$'\t' read -r ip user pass; do
    [ -n "$ip" ] || continue
    collect_one "$ip" "${user:-root}" "$pass"; handled=1
  done < <(python3 -c 'import json,sys
for h in json.loads(sys.argv[1]): print(h.get("ip",""), h.get("user",""), h.get("pass",""), sep="\t")' "$TARGET_HOSTS" 2>/dev/null)
elif command -v jq >/dev/null 2>&1; then
  while IFS=$'\t' read -r ip user pass; do
    [ -n "$ip" ] || continue
    collect_one "$ip" "${user:-root}" "$pass"; handled=1
  done < <(jq -r '.[] | [.ip, (.user//""), (.pass//"")] | @tsv' <<<"$TARGET_HOSTS" 2>/dev/null)
fi

# 兜底：没有 python3/jq 时，用 TARGET_IP + 首节点凭据
if [ "$handled" = "0" ]; then
  collect_one "$TARGET_IP" "$TARGET_USER" "$TARGET_PASSWORD"
fi

# 本机（工作台所在主机）日志片段：同为节点环境日志，落归档根目录
{
  echo "===== controller @ $(stamp) ====="
  echo "### uname"; uname -a 2>/dev/null
  echo "### uptime"; uptime 2>/dev/null
  echo "### dmesg tail"; (dmesg --time-format iso 2>/dev/null || dmesg 2>/dev/null) | tail -n 200
  echo "### nvidia-smi"; (nvidia-smi 2>/dev/null || echo "no nvidia-smi")
} >"$ARCHIVE_DIR/controller.log" 2>&1

# 如有 kubectl 且注入了命名空间，抓相关 pod 日志（NAMESPACE 未注入则跳过）；
# pod 日志与本次运行的负载相关，仍归档进本次运行文件夹（ARCHIVE_FOLDER）
if command -v kubectl >/dev/null 2>&1 && [ -n "${NAMESPACE:-}" ]; then
  echo "[collect_logs] collecting k8s pod logs in namespace=$NAMESPACE"
  kubectl -n "$NAMESPACE" get pods --no-headers 2>/dev/null | awk '{print $1}' | while read -r pod; do
    [ -n "$pod" ] || continue
    kubectl -n "$NAMESPACE" logs "$pod" --tail=300 2>/dev/null \
      >"$ARCHIVE_FOLDER/pod-${pod}.log" 2>&1
  done
fi

echo "[collect_logs] done -> hosts: $ARCHIVE_DIR, run: $ARCHIVE_FOLDER"
