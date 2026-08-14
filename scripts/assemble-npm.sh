#!/bin/bash
# npm 배포물 조립 — dist/ 산출물을 배포 패키지 형태로 스테이징한다.
#   npm-staging/ttym/                      메인 패키지 (CLI + 서버 번들, 플랫폼 무관)
#   npm-staging/holder-<platform>-<arch>/  네이티브 holder (optionalDependencies로 연결)
# postinstall 다운로드는 금지 계약이다 — 바이너리는 패키지 안에 산다.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -e "console.log(require('$ROOT/package.json').version)")
PLATFORM="${TTYM_NPM_PLATFORM:-$(node -e 'console.log(process.platform + "-" + process.arch)')}"
STAGE="$ROOT/npm-staging"

[ -f "$ROOT/dist/ttym" ] || { echo "dist/ 없음 — scripts/build.sh 먼저"; exit 1; }
rm -rf "$STAGE"
mkdir -p "$STAGE/ttym/dist" "$STAGE/holder-$PLATFORM"

# 메인 패키지 (holder 제외 — 플랫폼 패키지가 담당)
cp "$ROOT/dist/ttym" "$ROOT/dist/ttym-server.js" "$STAGE/ttym/dist/"
cp "$ROOT/README.md" "$STAGE/ttym/"
node - <<NODE
const fs = require('fs');
const platforms = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const optional = Object.fromEntries(platforms.map((p) => ['@ttym/holder-' + p, '$VERSION']));
fs.writeFileSync('$STAGE/ttym/package.json', JSON.stringify({
  name: 'ttym',
  version: '$VERSION',
  description: 'Web-based terminal multiplexer — sessions outlive the server; agents become callable',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/esc5221/ttym.git' },
  bin: { ttym: './dist/ttym' },
  files: ['dist/'],
  engines: { node: '>=20' },
  optionalDependencies: optional,
}, null, 2) + '\n');
NODE

# 플랫폼 holder 패키지 (현재 러너의 것 하나)
cp "$ROOT/dist/ttym-holder" "$STAGE/holder-$PLATFORM/"
node - <<NODE
const fs = require('fs');
const [os, cpu] = '$PLATFORM'.split('-');
fs.writeFileSync('$STAGE/holder-$PLATFORM/package.json', JSON.stringify({
  name: '@ttym/holder-$PLATFORM',
  version: '$VERSION',
  description: 'ttym PTY holder binary ($PLATFORM)',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/esc5221/ttym.git' },
  os: [os],
  cpu: [cpu],
  files: ['ttym-holder'],
}, null, 2) + '\n');
NODE

echo "staged: $STAGE/ttym + $STAGE/holder-$PLATFORM (v$VERSION)"
