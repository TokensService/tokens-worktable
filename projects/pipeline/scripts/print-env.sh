#!/usr/bin/env bash
# Print the process environment for pipeline diagnostics. Secrets are redacted
# by default so this script can be used safely from worktable logs.
set -euo pipefail

show_secrets="${SHOW_SECRETS:-0}"
case "$show_secrets" in
  0|1) ;;
  *) echo 'SHOW_SECRETS must be 0 or 1' >&2; exit 2 ;;
esac

# A generated pipeline contract holds values resolved by earlier stages. Load
# it for diagnostics when the caller provides its path; it contains no registry
# credentials by design.
if [[ -n "${PIPELINE_ENV_FILE:-}" && -f "$PIPELINE_ENV_FILE" ]]; then
  set -a
  source "$PIPELINE_ENV_FILE"
  set +a
fi

is_sensitive_name() {
  [[ "$1" =~ (^|_)(AK|SK|TOKEN|PASSWORD|PASS|SECRET|LOGIN_KEY|LOGKEY|AUTH|CREDENTIAL|API_KEY|KEY)$ ]]
}

while IFS= read -r -d '' entry; do
  name="${entry%%=*}"
  value="${entry#*=}"
  if [[ "$show_secrets" == 0 ]] && is_sensitive_name "$name"; then
    printf '%s=<redacted>\n' "$name"
  else
    printf '%s=%s\n' "$name" "$value"
  fi
done < <(env -0 | sort -z)
