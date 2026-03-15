#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="${ROOT_DIR}/dist/ttym"

if [[ ! -x "${CLI}" ]]; then
  echo "missing CLI: ${CLI}" >&2
  echo "run ./scripts/build.sh first" >&2
  exit 1
fi

project="pilot-$(date +%s)"
workspace="core"

cleanup() {
  "${CLI}" workspace delete "${project}/${workspace}" --json >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== start server =="
"${CLI}" start >/dev/null 2>&1 || true

echo "== create workspace =="
"${CLI}" workspace create "${project}" --name "${workspace}" --json

echo "== add members =="
"${CLI}" workspace add "${project}/${workspace}" --name lead --role agent --cmd /bin/sh -lc 'printf "lead-ready\n"; exec cat' --json
"${CLI}" workspace add "${project}/${workspace}" --name devserver --role server --cmd /bin/sh -lc 'printf "server-ready\n"; exec cat' --json

echo "== inspect workspace =="
"${CLI}" workspace info "${project}/${workspace}" --json

echo "== send commands =="
"${CLI}" workspace send "${project}/${workspace}" lead -- $'echo pilot-lead\n'
"${CLI}" workspace send "${project}/${workspace}" devserver -- $'echo pilot-server\n'

echo "== screens =="
"${CLI}" workspace screen "${project}/${workspace}" lead --json
"${CLI}" workspace screen "${project}/${workspace}" devserver --json

echo "== detach and remove =="
"${CLI}" workspace detach "${project}/${workspace}" devserver --json
"${CLI}" workspace remove "${project}/${workspace}" lead --json
"${CLI}" workspace info "${project}/${workspace}" --json

echo "== cleanup workspace =="
"${CLI}" workspace delete "${project}/${workspace}" --json

trap - EXIT
echo "pilot ok"
