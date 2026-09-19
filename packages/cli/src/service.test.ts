import { describe, expect, it } from 'vitest';
import { realpathSync } from 'node:fs';
import { renderLaunchdPlist, renderSystemdUnit, stableNodePath } from './service.js';

describe('service 파일 렌더러 — 설치 시점 생성, 정적 출하 금지', () => {
  const base = {
    nodePath: '/usr/local/bin/node', serverJs: '/x/dist/ttym-server.js',
    holderBin: '/x/dist/ttym-holder', port: 7690, homeDir: '/home/u/.ttym',
  };

  it('launchd: KeepAlive + 10초 스로틀 + 로그 단일화가 계약이다', () => {
    const xml = renderLaunchdPlist({ ...base, label: 'com.ttym.server', bind: null, logPath: '/home/u/.ttym/ttym.log' });
    expect(xml).toContain('<key>KeepAlive</key><true/>');
    expect(xml).toContain('<key>ThrottleInterval</key><integer>10</integer>');
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
    expect(unit).toContain('Environment=PORT=7690');
    expect(unit).not.toContain('TTYM_BIND');
  });
});
