#!/bin/bash
# ttym 벤치 한 번 (리눅스, systemd --user). 서버·holder·pane·메모리 압박을 slice 하나에 가두고 잰다.
# 이 머신의 다른 ttym(포트·홈·서비스)은 건드리지 않는다: 자기 포트, 자기 TTYM_HOME, 임시 유닛만 쓰고
# 끝나면 slice째 멈춘다.
#
#   scripts/bench/run.sh <label> [dist-dir]
#   환경: BENCH_PORT(7961) BENCH_MEM(6G) BENCH_SWAP(8G) BENCH_CPU(800%) BENCH_STAGES(JSON) …
set -euo pipefail
LABEL=${1:?label}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
DIST=${2:-$REPO/dist}
PORT=${BENCH_PORT:-7961}
SLICE=ttymbench.slice
UNIT=ttymbench-server
STRESS=ttymbench-stress
ROOT=${BENCH_ROOT:-$HOME/.ttym-bench}
RUN=$ROOT/runs/$(date +%y%m%d-%H%M%S)-$LABEL
HOMEDIR=$RUN/home
mkdir -p "$HOMEDIR" "$ROOT/frames" "$ROOT/results"
[ -f "$ROOT/frames/redraw-00.ansi" ] || node "$REPO/scripts/bench/synth.mjs" "$ROOT/frames" >&2

cleanup() {
  # 서버 유닛은 KillMode=process(재시작 시험 때 holder를 살려 둬야 해서)라 stop만으로는 holder가 남는다.
  # 이 slice 안만 통째로 끝낸다(cgroup v2 cgroup.kill) — slice 밖은 건드리지 않는다.
  local cg; cg=/sys/fs/cgroup$(systemctl --user show "$SLICE" -p ControlGroup --value 2>/dev/null)
  [ -n "$cg" ] && [ "$cg" != /sys/fs/cgroup ] && [ -w "$cg/cgroup.kill" ] && echo 1 > "$cg/cgroup.kill" 2>/dev/null || true
  sleep 0.5
  systemctl --user stop "$SLICE" "$UNIT" "$UNIT-2" "$STRESS" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$UNIT" "$UNIT-2" "$STRESS" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
if ss -ltn | grep -q ":$PORT "; then echo "port $PORT busy" >&2; exit 1; fi

start_server() {
  systemd-run --user --quiet --collect --slice="$SLICE" --unit="$1" -p KillMode=process \
    -p StandardOutput=append:"$RUN/server.log" -p StandardError=append:"$RUN/server.log" \
    --setenv=HOME="$HOME" --setenv=PATH=/usr/bin:/bin --setenv=TTYM_HOME="$HOMEDIR" \
    --setenv=PORT="$PORT" --setenv=TTYM_HOLDER_BIN="$DIST/ttym-holder" \
    /usr/bin/node "$DIST/ttym-server.js"
}
start_server "$UNIT"
systemctl --user set-property --runtime "$SLICE" MemoryMax="${BENCH_MEM:-6G}" MemorySwapMax="${BENCH_SWAP:-8G}" \
  CPUQuota="${BENCH_CPU:-800%}" IOWeight=50 ${BENCH_PROPS:-}
# BENCH_PROPS 예(macOS 압박에 가깝게): MemoryZSwapMax=0 IOReadBandwidthMax="/dev/nvme0n1 30M" IOWriteBandwidthMax="/dev/nvme0n1 30M"
for i in $(seq 1 100); do curl -sf -m 2 "http://127.0.0.1:$PORT/api/sessions" >/dev/null && break; sleep 0.2; done
CG=/sys/fs/cgroup$(systemctl --user show "$SLICE" -p ControlGroup --value)

GEN=0
export BENCH_PORT=$PORT BENCH_FRAMES=$ROOT/frames BENCH_LABEL=$LABEL BENCH_CGROUP=$CG \
  BENCH_COMMIT=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?') \
  BENCH_OUT=$ROOT/results/$(basename "$RUN").json \
  BENCH_SERVER_PID="ss -ltnpH 'sport = :$PORT' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2" \
  BENCH_STRESS_START="systemd-run --user --quiet --collect --slice=$SLICE --unit=$STRESS stress-ng --vm 1 --vm-bytes %BYTES% --vm-keep --timeout 3600s" \
  BENCH_STRESS_STOP="systemctl --user stop $STRESS" \
  BENCH_RESTART="kill -TERM \$(systemctl --user show -p MainPID --value $UNIT); for i in \$(seq 1 300); do ss -ltn | grep -q ':$PORT ' || break; sleep 0.1; done; systemd-run --user --quiet --collect --slice=$SLICE --unit=$UNIT-2 -p KillMode=process -p StandardOutput=append:$RUN/server.log -p StandardError=append:$RUN/server.log --setenv=HOME=$HOME --setenv=PATH=/usr/bin:/bin --setenv=TTYM_HOME=$HOMEDIR --setenv=PORT=$PORT --setenv=TTYM_HOLDER_BIN=$DIST/ttym-holder /usr/bin/node $DIST/ttym-server.js"
node "$REPO/scripts/bench/client.mjs"
echo "result: $BENCH_OUT" >&2
