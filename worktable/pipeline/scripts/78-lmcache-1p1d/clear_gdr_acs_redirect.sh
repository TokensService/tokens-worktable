#!/usr/bin/env bash
set -euo pipefail

setpci_bin="${SETPCI:-setpci}"
restore_file=""
dry_run=0
check_only=0
clear_mask=0x000c

bdfs=()
gpus=()
rdma_devices=()
pairs=()

usage() {
  cat <<'USAGE'
Usage:
  clear_gdr_acs_redirect.sh [options]
  clear_gdr_acs_redirect.sh --restore STATE_FILE [options]

Clear ACS ReqRedir/CmpltRedir bits on PCIe bridges in local GPU/RDMA paths.

NVIDIA display/3D devices and RDMA devices exposed by /sys/class/infiniband
are discovered at runtime. Each GPU is paired one-to-one with the closest
RDMA device that shares a PCIe ancestor. Non-paired RDMA devices are ignored.

Options:
  --setpci PATH          setpci binary. Default: SETPCI env var, then PATH setpci
  --restore STATE_FILE   Restore ACSCtl values from a previous state file.
  --check                Print current ACSCtl values and whether redirect is enabled.
  --dry-run              Print planned actions without changing PCI config space.
  -h, --help             Show this help.

Notes:
  ReqRedir is bit 2 and CmpltRedir is bit 3 in ACSCtl, so this clears mask 0x000c.
  Changes made with setpci are runtime-only and normally reset on reboot.
USAGE
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

need_setpci() {
  if [[ "$setpci_bin" == */* ]]; then
    [[ -x "$setpci_bin" ]] || fail "$setpci_bin is not executable"
  else
    command -v "$setpci_bin" >/dev/null 2>&1 || fail "setpci not found; pass --setpci PATH"
  fi
}

is_bdf() {
  [[ "$1" =~ ^[[:xdigit:]]{4}:[[:xdigit:]]{2}:[[:xdigit:]]{2}\.[[:xdigit:]]$ ]]
}

discover_endpoints() {
  local device vendor class ib bdf
  local -A seen_rdma=()

  gpus=()
  for device in /sys/bus/pci/devices/*; do
    [[ -r "$device/vendor" && -r "$device/class" ]] || continue
    read -r vendor <"$device/vendor"
    read -r class <"$device/class"
    if [[ "${vendor,,}" == "0x10de" && "${class,,}" =~ ^0x03(00|02) ]]; then
      gpus+=("$(basename "$device")")
    fi
  done
  ((${#gpus[@]} > 0)) || fail "no NVIDIA GPU PCI devices found"
  mapfile -t gpus < <(printf '%s\n' "${gpus[@]}" | LC_ALL=C sort)

  rdma_devices=()
  for ib in /sys/class/infiniband/*; do
    [[ -e "$ib/device" ]] || continue
    device="$(readlink -f "$ib/device")"
    bdf="$(basename "$device")"
    is_bdf "$bdf" || continue
    [[ -n "${seen_rdma[$bdf]:-}" ]] && continue
    seen_rdma["$bdf"]=1
    rdma_devices+=("$bdf")
  done
  ((${#rdma_devices[@]} > 0)) || fail "no PCI RDMA devices found under /sys/class/infiniband"
  mapfile -t rdma_devices < <(printf '%s\n' "${rdma_devices[@]}" | LC_ALL=C sort)
}

topology_distance() {
  local left="$1" right="$2" left_path right_path i common=0 shared_phb=0
  local -a left_parts right_parts

  left_path="$(readlink -f "/sys/bus/pci/devices/$left")"
  right_path="$(readlink -f "/sys/bus/pci/devices/$right")"
  IFS=/ read -r -a left_parts <<<"$left_path"
  IFS=/ read -r -a right_parts <<<"$right_path"
  for ((i = 0; i < ${#left_parts[@]} && i < ${#right_parts[@]}; i++)); do
    [[ "${left_parts[$i]}" == "${right_parts[$i]}" ]] || break
    common=$((i + 1))
    if [[ "${left_parts[$i]}" =~ ^pci[[:xdigit:]]{4}:[[:xdigit:]]{2}$ ]]; then
      shared_phb=1
    fi
  done
  ((shared_phb == 1)) || return 1
  printf '%d\n' "$(( ${#left_parts[@]} + ${#right_parts[@]} - 2 * common ))"
}

pair_endpoints() {
  local gpu rdma distance line
  local -a candidates=()
  local -A gpu_used=() rdma_used=() gpu_pair=()

  ((${#rdma_devices[@]} >= ${#gpus[@]})) || \
    fail "found ${#gpus[@]} GPUs but only ${#rdma_devices[@]} RDMA PCI devices"

  for gpu in "${gpus[@]}"; do
    for rdma in "${rdma_devices[@]}"; do
      if distance="$(topology_distance "$gpu" "$rdma")"; then
        candidates+=("$(printf '%08d %s %s' "$distance" "$gpu" "$rdma")")
      fi
    done
  done
  ((${#candidates[@]} > 0)) || fail "no GPU and RDMA device share a PCIe ancestor"
  mapfile -t candidates < <(printf '%s\n' "${candidates[@]}" | LC_ALL=C sort)

  for line in "${candidates[@]}"; do
    read -r distance gpu rdma <<<"$line"
    [[ -z "${gpu_used[$gpu]:-}" && -z "${rdma_used[$rdma]:-}" ]] || continue
    gpu_used["$gpu"]=1
    rdma_used["$rdma"]=1
    gpu_pair["$gpu"]="$rdma"
  done

  pairs=()
  for gpu in "${gpus[@]}"; do
    rdma="${gpu_pair[$gpu]:-}"
    [[ -n "$rdma" ]] || fail "could not find a unique local RDMA peer for GPU $gpu"
    distance="$(topology_distance "$gpu" "$rdma")"
    pairs+=("$gpu $rdma $distance")
  done
}

discover_bridges() {
  local pair gpu rdma distance endpoint path component class value
  local -a parts
  local -A candidates=()

  for pair in "${pairs[@]}"; do
    read -r gpu rdma distance <<<"$pair"
    for endpoint in "$gpu" "$rdma"; do
      path="$(readlink -f "/sys/bus/pci/devices/$endpoint")"
      IFS=/ read -r -a parts <<<"$path"
      for component in "${parts[@]}"; do
        is_bdf "$component" || continue
        [[ "$component" != "$endpoint" ]] || continue
        candidates["$component"]=1
      done
    done
  done

  bdfs=()
  for component in "${!candidates[@]}"; do
    [[ -r "/sys/bus/pci/devices/$component/class" ]] || continue
    read -r class <"/sys/bus/pci/devices/$component/class"
    [[ "${class,,}" =~ ^0x0604 ]] || continue
    if value="$("$setpci_bin" -s "$component" ECAP_ACS+6.w 2>/dev/null)" && \
       [[ "$value" =~ ^[[:xdigit:]]{4}$ ]]; then
      bdfs+=("$component")
    fi
  done
  ((${#bdfs[@]} > 0)) || fail "no ACS-capable PCIe bridges found in paired GPU/RDMA paths"
  mapfile -t bdfs < <(printf '%s\n' "${bdfs[@]}" | LC_ALL=C sort)
}

discover_topology() {
  discover_endpoints
  pair_endpoints
  discover_bridges
}

read_acsctl() {
  local bdf="$1"
  "$setpci_bin" -s "$bdf" ECAP_ACS+6.w
}

write_acsctl() {
  local bdf="$1"
  local value="$2"
  "$setpci_bin" -s "$bdf" ECAP_ACS+6.w="$value"
}

clear_acs_redirect_bits() {
  local bdf="$1"
  "$setpci_bin" -s "$bdf" ECAP_ACS+6.w=0000:000c
}

has_redirect() {
  local value="$1"
  [[ "$value" =~ ^[[:xdigit:]]{4}$ ]] || return 2
  (( (0x$value & clear_mask) != 0 ))
}

redirect_is_cleared() {
  local value="$1"
  [[ "$value" =~ ^[[:xdigit:]]{4}$ ]] && (( (0x$value & clear_mask) == 0 ))
}

print_plan() {
  cat <<EOF
setpci=$setpci_bin
clear_mask=$(printf '0x%04x' "$clear_mask")
pairings:
EOF
  local pair gpu rdma distance bdf
  for pair in "${pairs[@]}"; do
    read -r gpu rdma distance <<<"$pair"
    printf '  GPU %s <-> RDMA %s (distance=%s)\n' "$gpu" "$rdma" "$distance"
  done
  cat <<EOF
bridges:
EOF
  for bdf in "${bdfs[@]}"; do
    echo "  $bdf"
  done
}

check_state() {
  local bdf value status
  for bdf in "${bdfs[@]}"; do
    value="$(read_acsctl "$bdf")"
    if ! [[ "$value" =~ ^[[:xdigit:]]{4}$ ]]; then
      status="invalid-value"
    elif has_redirect "$value"; then
      status="redirect-enabled"
    else
      status="redirect-cleared"
    fi
    printf '%s ACSCtl=%s %s\n' "$bdf" "$value" "$status"
  done
}

clear_redirect() {
  local bdf old new readback changed_bdf
  local -a changed=()
  local -A originals=()

  for bdf in "${bdfs[@]}"; do
    old="$(read_acsctl "$bdf")"
    [[ "$old" =~ ^[[:xdigit:]]{4}$ ]] || fail "invalid ACSCtl value for $bdf: $old"
    originals["$bdf"]="$old"
  done

  for bdf in "${bdfs[@]}"; do
    old="${originals[$bdf]}"
    new="$(printf '%04x' $(( 0x$old & ~clear_mask )))"
    changed+=("$bdf")
    if ! clear_acs_redirect_bits "$bdf" || ! readback="$(read_acsctl "$bdf")" || ! redirect_is_cleared "$readback"; then
      echo "ERROR: failed to clear/verify ACS redirect on $bdf; rolling back" >&2
      for changed_bdf in "${changed[@]}"; do
        write_acsctl "$changed_bdf" "${originals[$changed_bdf]}" || true
      done
      exit 1
    fi
    printf '%s old=%s new=%s readback=%s\n' "$bdf" "$old" "$new" "$readback"
  done
}

restore_state() {
  local bdf value readback
  [[ -f "$restore_file" ]] || fail "restore state file not found: $restore_file"
  echo "Restoring ACS state from: $restore_file"
  while read -r bdf value; do
    [[ -n "${bdf:-}" ]] || continue
    is_bdf "$bdf" || fail "invalid BDF in restore state: $bdf"
    [[ "$value" =~ ^[[:xdigit:]]{4}$ ]] || fail "invalid ACSCtl value for $bdf: ${value:-<missing>}"
    write_acsctl "$bdf" "$value"
    readback="$(read_acsctl "$bdf")"
    [[ "${readback,,}" == "${value,,}" ]] || \
      fail "restore verification failed for $bdf: expected=$value readback=$readback"
    printf '%s restored=%s readback=%s\n' "$bdf" "$value" "$readback"
  done <"$restore_file"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setpci)
      [[ $# -ge 2 ]] || fail "missing value for --setpci"
      setpci_bin="$2"
      shift 2
      ;;
    --restore)
      [[ $# -ge 2 ]] || fail "missing value for --restore"
      restore_file="$2"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

mode_count=0
[[ -n "$restore_file" ]] && mode_count=$((mode_count + 1))
((check_only == 1)) && mode_count=$((mode_count + 1))
((mode_count <= 1)) || fail "--restore and --check are mutually exclusive"

if [[ "$dry_run" -eq 1 && -n "$restore_file" ]]; then
  echo "DRY RUN"
  echo "would_restore=$restore_file"
  exit 0
fi

need_setpci

if [[ -z "$restore_file" ]]; then
  discover_topology
fi

if [[ "$dry_run" -eq 1 ]]; then
  echo "DRY RUN"
  print_plan
  if [[ "$check_only" -eq 1 ]]; then
    echo "would_check=1"
  else
    echo "would_clear_redirect=1"
  fi
  exit 0
fi

if [[ -n "$restore_file" ]]; then
  restore_state
elif [[ "$check_only" -eq 1 ]]; then
  check_state
else
  clear_redirect
fi
