import { describe, expect, it } from 'vitest';
import { renderLaunchdPlist, renderSystemdUnit } from './service.js';

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
