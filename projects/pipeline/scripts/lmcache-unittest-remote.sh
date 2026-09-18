#!/usr/bin/env bash
# Shared target-host transport for the LMCache unit-test stages.
# The worktable process only opens SSH connections; container operations stay
# entirely on TARGET_HOSTS[0].  TARGET_IP remains supported for simple callers.

lmcache_remote_init() {
  local parsed
  command -v ssh >/dev/null 2>&1 || {
    echo 'ssh is required on the pipeline execution host' >&2
    return 2
  }

  local fallback_ip fallback_user
  fallback_ip="${LMCACHE_UNITTEST_TARGET_IP:-${TARGET_IP:-}}"
  if [[ -n "${LMCACHE_UNITTEST_TARGET_PORT:-}" && "$fallback_ip" != *:* ]]; then
    fallback_ip="${fallback_ip}:${LMCACHE_UNITTEST_TARGET_PORT}"
  fi
  fallback_user="${LMCACHE_UNITTEST_TARGET_USER:-${TARGET_USER:-root}}"
  parsed="$(python3 - "${TARGET_HOSTS:-}" "$fallback_ip" "$fallback_user" "${SSH_PASSWORD:-${TARGET_PASSWORD:-}}" <<'PY'
import json
import re
import sys

hosts_text, fallback_ip, default_user, fallback_password = sys.argv[1:]
if hosts_text:
    try:
        hosts = json.loads(hosts_text)
    except json.JSONDecodeError as error:
        raise SystemExit(f"invalid TARGET_HOSTS: {error}")
    if not isinstance(hosts, list) or not hosts:
        raise SystemExit("TARGET_HOSTS must be a non-empty JSON array")
    item = hosts[0]
    if not isinstance(item, dict) or not isinstance(item.get("ip"), str) or not item["ip"]:
        raise SystemExit("TARGET_HOSTS[0].ip must be a non-empty string")
    endpoint = item["ip"]
    user = item.get("user") or default_user
    password = item.get("pass", item.get("password", fallback_password))
else:
    endpoint = fallback_ip
    user = default_user
    password = fallback_password

if not isinstance(endpoint, str) or not endpoint:
    raise SystemExit("TARGET_HOSTS or TARGET_IP must provide a target")
match = re.fullmatch(r"([^:]+):(\d+)", endpoint)
if match:
    host, port = match.groups()
    if not 1 <= int(port) <= 65535:
        raise SystemExit(f"invalid target port: {endpoint}")
else:
    host, port = endpoint, "22"
if not isinstance(user, str) or not user:
    raise SystemExit("target user must be a non-empty string")
if password is None:
    password = ""
if not isinstance(password, str):
    raise SystemExit("target password must be a string when specified")
print(host, port, user, password, sep="\t")
PY
)" || return $?
  IFS=$'\t' read -r LMCACHE_UNITTEST_TARGET_IP LMCACHE_UNITTEST_TARGET_PORT \
    LMCACHE_UNITTEST_TARGET_USER LMCACHE_UNITTEST_TARGET_PASSWORD <<<"$parsed"
  LMCACHE_UNITTEST_TARGET="${LMCACHE_UNITTEST_TARGET_USER}@${LMCACHE_UNITTEST_TARGET_IP}"
}

lmcache_remote() {
  if [[ -n "${LMCACHE_UNITTEST_TARGET_PASSWORD:-}" ]]; then
    command -v sshpass >/dev/null 2>&1 || {
      echo 'sshpass is required for password-authenticated target execution' >&2
      return 2
    }
    SSHPASS="$LMCACHE_UNITTEST_TARGET_PASSWORD" sshpass -e ssh \
      -p "$LMCACHE_UNITTEST_TARGET_PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 "$LMCACHE_UNITTEST_TARGET" "$@"
  else
    ssh -p "$LMCACHE_UNITTEST_TARGET_PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 "$LMCACHE_UNITTEST_TARGET" "$@"
  fi
}

# Copy files from the selected target host to the pipeline execution host.
# Callers pass normal scp source/destination arguments after this helper.
lmcache_remote_scp() {
  if [[ -n "${LMCACHE_UNITTEST_TARGET_PASSWORD:-}" ]]; then
    command -v sshpass >/dev/null 2>&1 || {
      echo 'sshpass is required for password-authenticated target log copy' >&2
      return 2
    }
    SSHPASS="$LMCACHE_UNITTEST_TARGET_PASSWORD" sshpass -e scp \
      -P "$LMCACHE_UNITTEST_TARGET_PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 "$@"
  else
    scp -P "$LMCACHE_UNITTEST_TARGET_PORT" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o LogLevel=ERROR -o ConnectTimeout=30 "$@"
  fi
}
