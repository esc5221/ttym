import { describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeIdentityWarning, renderLaunchdPlist, renderSystemdUnit, runtimeNodePath, stableNodePath } from './service.js';

describe('서버 node 고르기 — macOS가 pane 권한을 이 바이너리로 판정한다', () => {
  const put = (dir: string, name: string, exec = true) => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'node'), '');
    chmodSync(join(dir, name, 'node'), exec ? 0o755 : 0o644);
  };

  it('runtime 폴더가 없으면 null — 기존 경로(stableNodePath)로 간다', () => {
    expect(runtimeNodePath(join(tmpdir(), 'ttym-no-such-runtime'))).toBeNull();
  });

  it('버전 폴더 중 가장 높은 것 (문자열 순이 아니라 숫자 순), 실행 못 하는 것·이름이 다른 것은 뺀다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttym-runtime-'));
    put(dir, 'v26.9.0');
    put(dir, 'v26.13.0');
    put(dir, 'v27.0.0', false);       // 실행 비트 없음
    put(dir, 'v28.0.0-rc.1');         // 정식 버전 형식이 아님
    mkdirSync(join(dir, 'v29.0.0'));  // node 파일 없음
    expect(runtimeNodePath(dir)).toBe(join(dir, 'v26.13.0', 'node'));
  });

  it('경고: adhoc 이거나 Homebrew 경로면 경고, 공식 서명 + 고정 경로면 없음', () => {
    expect(nodeIdentityWarning('/opt/homebrew/bin/node', { identifier: 'node-5555', team: null })).toMatch(/ad-hoc/);
    expect(nodeIdentityWarning('/opt/homebrew/bin/node', { identifier: 'node', team: 'HX7739G8FX' })).toMatch(/Homebrew/);
    expect(nodeIdentityWarning('/home/u/.ttym/runtime/v26.13.0/node', { identifier: 'node', team: 'HX7739G8FX' })).toBeNull();
    expect(nodeIdentityWarning('/x/node', null)).toBeNull(); // codesign 없음(리눅스) — 판단하지 않는다
  });
});

describe('service 파일 렌더러 — 설치 시점 생성, 정적 출하 금지', () => {
  const base = {
    nodePath: '/usr/local/bin/node', serverJs: '/x/dist/ttym-server.js',
    holderBin: '/x/dist/ttym-holder', port: 7690, homeDir: '/home/u/.ttym',
  };

  it('launchd: KeepAlive + 10초 스로틀 + 로그 단일화가 계약이다', () => {
    const xml = renderLaunchdPlist({ ...base, label: 'com.ttym.server', bind: null, logPath: '/home/u/.ttym/ttym.log' });
    expect(xml).toContain('<key>KeepAlive</key><true/>');
    expect(xml).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    // 비우면 launchd가 CPU·I/O를 조인다 — pane 안 프로그램까지 물려받는다
    expect(xml).toContain('<key>ProcessType</key><string>Interactive</string>');
    // stdout과 stderr가 같은 파일 — 이중 로그 방지
    expect(xml.match(/<string>\/home\/u\/\.ttym\/ttym\.log<\/string>/g)?.length).toBe(2);
    expect(xml).toContain('<key>PORT</key><string>7690</string>');
    expect(xml).not.toContain('TTYM_BIND'); // bind 미지정이면 키 자체가 없다
  });

  it('launchd: PATH·HOME은 주면 env에 실린다 — 세션이 그대로 물려받는다', () => {
    const xml = renderLaunchdPlist({
      ...base, label: 'l', bind: null, logPath: '/l',
      path: '/opt/homebrew/bin:/usr/bin', home: '/home/u',
    });
    expect(xml).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
    expect(xml).toContain('<key>HOME</key><string>/home/u</string>');
  });

  it('launchd: PATH를 안 주면 키가 없다 — launchd 기본 PATH', () => {
    const xml = renderLaunchdPlist({ ...base, label: 'l', bind: null, logPath: '/l' });
    expect(xml).not.toContain('<key>PATH</key>');
  });

  it('nodePath: Cellar 버전 경로 대신 같은 실행파일을 가리키는 심링크를 쓴다', () => {
    // 이 머신의 node가 무엇이든, 반환값은 실제로 같은 파일을 가리켜야 한다.
    const picked = stableNodePath(process.execPath);
    expect(realpathSync(picked)).toBe(realpathSync(process.execPath));
  });

  it('launchd: bind 옵트인은 env로 전달된다', () => {
    const xml = renderLaunchdPlist({ ...base, label: 'l', bind: '0.0.0.0', logPath: '/l' });
    expect(xml).toContain('<key>TTYM_BIND</key><string>0.0.0.0</string>');
  });

  it('systemd: on-failure 재기동 + 10초 간격', () => {
    const unit = renderSystemdUnit({ ...base, bind: null });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=10');
    // 기본(control-group)이면 재시작이 cgroup 안의 holder 를 모두 죽인다
    expect(unit).toContain('KillMode=process');
    expect(unit).toContain('Environment=PORT=7690');
    expect(unit).not.toContain('TTYM_BIND');
  });
});
