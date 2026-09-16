#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for script in render-config.sh pull_render_config.sh; do
  prefix=$(sed '/^ARCH_NAME=/q' "$script_dir/$script" | sed '/^SCRIPT_DIR=/d')
  for scenario in preferred strategy legacy runtime empty default; do
    actual=$(env -u arch_name -u DEPLOY_STRATEGY -u arch -u ARCH_NAME bash -s -- "$scenario" "$prefix" <<'CASE'
case "$1" in
 preferred) export arch_name=lower DEPLOY_STRATEGY=strategy ARCH_NAME=legacy arch=runtime ;;
 strategy) export arch_name= DEPLOY_STRATEGY=strategy ARCH_NAME=legacy arch=runtime ;;
 legacy) export ARCH_NAME=legacy arch=runtime ;;
 runtime) export arch=runtime ;;
 empty) export arch_name= DEPLOY_STRATEGY= arch= ARCH_NAME=legacy ;;
 default) : ;;
esac
eval "$2"
printf '%s' "$ARCH_NAME"
CASE
)
    case "$scenario" in preferred) expected=lower;; strategy) expected=strategy;; legacy|empty) expected=legacy;; runtime) expected=runtime;; default) expected=default;; esac
    [[ "$actual" == "$expected" ]] || { echo "FAIL $script $scenario: $actual != $expected"; exit 1; }
  done
  echo "PASS $script: arch_name > DEPLOY_STRATEGY > ARCH_NAME > arch > default"
done
