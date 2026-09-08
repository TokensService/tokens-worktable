#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for script in render-config.sh pull_render_config.sh; do
  prefix=$(sed '/^ARCH_NAME=/q' "$script_dir/$script" | sed '/^SCRIPT_DIR=/d')
  for scenario in preferred strategy legacy empty default; do
    actual=$(env -u arch_name -u DEPLOY_STRATEGY -u ARCH_NAME bash -s -- "$scenario" "$prefix" <<'CASE'
case "$1" in
 preferred) export arch_name=lower DEPLOY_STRATEGY=strategy ARCH_NAME=legacy ;;
 strategy) export arch_name= DEPLOY_STRATEGY=strategy ARCH_NAME=legacy ;;
 legacy) export ARCH_NAME=legacy ;;
 empty) export arch_name= DEPLOY_STRATEGY= ARCH_NAME=legacy ;;
 default) : ;;
esac
eval "$2"
printf '%s' "$ARCH_NAME"
CASE
)
    case "$scenario" in preferred) expected=lower;; strategy) expected=strategy;; legacy|empty) expected=legacy;; default) expected=default;; esac
    [[ "$actual" == "$expected" ]] || { echo "FAIL $script $scenario: $actual != $expected"; exit 1; }
  done
  echo "PASS $script: arch_name > DEPLOY_STRATEGY > ARCH_NAME > default"
done
