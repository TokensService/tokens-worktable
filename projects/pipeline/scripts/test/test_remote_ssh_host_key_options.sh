#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/bin"

cat >"$work_dir/bin/sshpass" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == "-e" ]] && shift
exec "$@"
SH
cat >"$work_dir/bin/ssh" <<'SH'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >>"$SSH_OPTION_LOG"
SH
cat >"$work_dir/bin/scp" <<'SH'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >>"$SSH_OPTION_LOG"
SH
chmod +x "$work_dir/bin/sshpass" "$work_dir/bin/ssh" "$work_dir/bin/scp"

for script_name in cleanup-env.sh check-env.sh evict-ems-hugepages.sh; do
  log_file="$work_dir/${script_name}.log"
  (
    PATH="$work_dir/bin:$PATH"
    SSH_OPTION_LOG="$log_file"
    export PATH SSH_OPTION_LOG
    source <(sed '/^main "\$@"$/d' "$script_dir/$script_name")
    SSH_PASSWORD=test-password
    remote_scp source-file root@192.0.2.10:/tmp/target-file
    remote_ssh root@192.0.2.10 true
    SSH_PASSWORD=''
    remote_scp source-file root@192.0.2.10:/tmp/target-file
    remote_ssh root@192.0.2.10 true
  )
  [[ "$(wc -l <"$log_file")" -eq 4 ]]
  while IFS= read -r invocation; do
    [[ "$invocation" == *"-o StrictHostKeyChecking=no"* ]]
    [[ "$invocation" == *"-o UserKnownHostsFile=/dev/null"* ]]
  done <"$log_file"
done

echo 'PASS: every remote maintenance entry skips first-login host-key prompts'
