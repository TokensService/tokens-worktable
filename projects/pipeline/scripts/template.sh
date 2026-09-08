#!/usr/bin/env bash
# 脚本模板：演示流水线注入变量的用法
# 在「编辑流水线」里给阶段绑定本脚本，点「识别参数」即可看到可配置项。
#
# 位置参数（识别为位置参数 1）：
#   $1 = 模型名（默认 xds）
#
# 注入的环境变量（流水线运行时自动注入；在此显式给出默认值=可被页面覆盖）：
#   TARGET_IP       首个目标节点 IP（默认 127.0.0.1）
#   TARGET_USER     首个节点用户名（默认 root）
#   TARGET_PASSWORD 首个节点密码（默认空；不要为它写默认值，演示用 :- 即可）
#   TARGET_IPS      全部目标 IP 的 JSON 数组（多选环境时注入）
#   TARGET_HOSTS    全部节点的 JSON 数组 [{ip,user,pass}]（多节点各自凭据）
#   IMAGE_NAME      镜像名（主控「镜像名」输入框）
#   IMAGE_TAG       本次运行 tag（如 1510-a1b2c）
#   PIPELINE_NAME   流水线名
#   GIT_URL         代码仓地址（主控选择的目标仓库）
#   GIT_BRANCH      主控填写的分支
#   GIT_USER        仓库访问令牌用户名
#   GIT_PASSWORD    仓库访问令牌（不要写默认值，演示用 :- 即可）
#   DEPLOY_STRATEGY 部署策略（配置了部署策略 URL 时按所选分支注入）
#   ARCHIVE_*       归档相关（ARCHIVE_LOG_FILE/ARCHIVE_PROFILE_FILE/ARCHIVE_RESULT 仅注入归档脚本）
set -e

MODEL="${1:-xds}"
TARGET_IP="${TARGET_IP:-127.0.0.1}"
TARGET_USER="${TARGET_USER:-root}"
TARGET_PASSWORD="${TARGET_PASSWORD:-}"
TARGET_IPS="${TARGET_IPS:-[]}"
TARGET_HOSTS="${TARGET_HOSTS:-[]}"
IMAGE_NAME="${IMAGE_NAME:-myapp}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
PIPELINE_NAME="${PIPELINE_NAME:-unknown}"
GIT_URL="${GIT_URL:-}"
GIT_BRANCH="${GIT_BRANCH:-}"
GIT_USER="${GIT_USER:-}"
GIT_PASSWORD="${GIT_PASSWORD:-}"
DEPLOY_STRATEGY="${DEPLOY_STRATEGY:-}"

echo "XDS_BRANCH=$XDS_BRANCH"

# 打印流水线运行时系统注入的全部环境变量（未注入的显示 <未注入>）
# 注意：TARGET_PASSWORD / TARGET_HOSTS / GIT_PASSWORD 含节点/仓库凭据，会明文出现在阶段日志与归档日志中
echo "[template] ---- 系统注入的环境变量 ----"
for v in PIPELINE_NAME IMAGE_NAME IMAGE_TAG \
         TARGET_IP TARGET_USER TARGET_PASSWORD TARGET_IPS TARGET_HOSTS \
         GIT_URL GIT_BRANCH GIT_USER GIT_PASSWORD DEPLOY_STRATEGY \
         ARCHIVE_DIR ARCHIVE_FOLDER ARCHIVE_PIPELINE ARCHIVE_TAG \
         ARCHIVE_LOG_FILE ARCHIVE_PROFILE_FILE ARCHIVE_RESULT; do
  echo "[template]   $v=${!v:-<未注入>}"
done
echo "[template] -----------------------------"

echo "[template] pipeline=$PIPELINE_NAME model=$MODEL"
echo "[template] image=$IMAGE_NAME:$IMAGE_TAG"
echo "[template] primary target: $TARGET_USER@$TARGET_IP"

# 多节点遍历（各自凭据）：TARGET_HOSTS 是 [{ip,user,pass}] JSON 数组
deploy_one() {   # $1=ip $2=user $3=pass
  echo "[template] -> deploy $IMAGE_NAME:$IMAGE_TAG to $2@$1"
  # 示例：真实部署时取消注释（需要 sshpass 或免密；UserKnownHostsFile=/dev/null 免疫首次登录确认与指纹变更）
  # sshpass -p "$3" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$2@$1" \
  #   "docker pull $IMAGE_NAME:$IMAGE_TAG && docker run -d $IMAGE_NAME:$IMAGE_TAG"
}

handled=0
if command -v python3 >/dev/null 2>&1; then
  while IFS=$'\t' read -r ip user pass; do
    [ -n "$ip" ] || continue
    deploy_one "$ip" "${user:-root}" "$pass"
    handled=1
  done < <(python3 -c 'import json,sys
for h in json.loads(sys.argv[1]): print(h.get("ip",""), h.get("user",""), h.get("pass",""), sep="\t")' "$TARGET_HOSTS" 2>/dev/null)
elif command -v jq >/dev/null 2>&1; then
  while IFS=$'\t' read -r ip user pass; do
    [ -n "$ip" ] || continue
    deploy_one "$ip" "${user:-root}" "$pass"
    handled=1
  done < <(jq -r '.[] | [.ip, (.user//""), (.pass//"")] | @tsv' <<<"$TARGET_HOSTS" 2>/dev/null)
fi

# 兜底：没有 python3/jq 时，用 TARGET_IPS（仅 IP）+ 首个节点凭据
if [ "$handled" = "0" ]; then
  IPS="$TARGET_IP"
  if command -v python3 >/dev/null 2>&1; then
    IPS=$(python3 -c 'import json,sys; print(" ".join(json.loads(sys.argv[1])))' "$TARGET_IPS" 2>/dev/null || true)
    [ -z "$IPS" ] && IPS="$TARGET_IP"
  fi
  for ip in $IPS; do deploy_one "$ip" "$TARGET_USER" "$TARGET_PASSWORD"; done
fi

echo "[template] done"
