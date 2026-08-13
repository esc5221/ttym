import type React from 'react';
import * as api from '@ttym/api';
import { workspaceLabel, memberNameBySession, layoutToSessionIds, type LayoutNode } from '@ttym/shared';

/** App의 모든 페이지가 공유하는 타입·서버 API·라우팅·공용 스타일.
 *  페이지 파일(App/DashboardPage/MapPage)은 여기서만 가져다 쓴다 — 순환 없음. */

// ───── Workspace 타입 + Server API ─────

export interface WorkspaceMember {
  sessionId: number;
  name: string;
  role?: string;
  tags?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionMeta {
  cwd?: string | null;
  [key: string]: unknown;
}

export interface PanelState {
  key: string;
  sessionId?: number;
  memberName?: string;
  cwd?: string;
  dead?: boolean;
}

export interface Workspace {
  id: string;
  project: string;
  name: string;
  layout: LayoutNode;
  members: WorkspaceMember[];
  createdAt: number;
  updatedAt: number;
}

export const LOCAL_ECHO_STORAGE_KEY = 'ttym-demo-local-echo';

// UI 스타일: frame(기본) = bg0 들판 + 라운드 프레임 + dim 포커스,
// classic = bg2 크롬 바 + 좌측 포커스 바. 차이는 전부 이 테이블 한 곳에 산다.
export type UiStyle = 'frame' | 'classic';

// 데스크톱 셸(Tauri)이 주입하는 마커 — 순수 데이터, IPC 없음.
// 감지되면 트래픽라이트 자리를 비우고 스트립을 창 드래그 영역으로 쓴다.
export const IS_NATIVE = typeof (window as unknown as { __TTYM_NATIVE__?: unknown }).__TTYM_NATIVE__ !== 'undefined';
export const UI_STYLE_STORAGE_KEY = 'ttym-ui-style';

export const UI_STYLES = {
  frame: {
    stripBg: 'var(--bg0)',
    stripLine: 'none',
    tabActiveBg: 'var(--bg2)',
    wrapPad: 5,
    splitterPx: 6,
    splitterColor: 'transparent',
    paneRadius: 6,
    termPad: '0 6px 6px',
    frameBorder: true,
    headerBar: false,
  },
  classic: {
    stripBg: 'var(--bg2)',
    stripLine: '1px solid var(--line)',
    tabActiveBg: 'var(--bg0)',
    wrapPad: 0,
    splitterPx: 5,
    splitterColor: 'var(--line)',
    paneRadius: 0,
    termPad: '0',
    frameBorder: false,
    headerBar: true,
  },
} as const;

export function readUiStyle(): UiStyle {
  try { return localStorage.getItem(UI_STYLE_STORAGE_KEY) === 'classic' ? 'classic' : 'frame'; } catch { return 'frame'; }
}

// 에이전트 식별색 — 정체는 이름의 색, 활동은 4px 점. 필 배지는 쓰지 않는다.
export const AGENT_COLORS: Record<string, string> = { 'claude-code': 'var(--agent-claude)', codex: 'var(--agent-codex)' };

export interface AgentState { kind: 'claude-code' | 'codex' | null; active: boolean }

export function readLocalEchoEnabled(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_ECHO_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLocalEchoEnabled(value: boolean) {
  try {
    window.localStorage.setItem(LOCAL_ECHO_STORAGE_KEY, value ? '1' : '0');
  } catch {}
}

/** Derive ttym server host from current page URL */
export function getTtymHost(): string {
  const h = window.location.hostname;
  // ttym-ui.lullu.lan → ttym.lullu.lan (Caddy proxy, port 80)
  if (h.startsWith('ttym-ui.')) return `ttym.${h.slice(8)}`;
  // tunnel or same-origin proxy → use current host (Vite proxies /api and /ws)
  if (h.startsWith('ttym.') || h === 'localhost' || h === '127.0.0.1') return window.location.host;
  // fallback: same host, port 7690
  return `${h}:7690`;
}
export const TTYM_HOST = getTtymHost();
export const isSecure = window.location.protocol === 'https:';
export const API_BASE = `${isSecure ? 'https' : 'http'}://${TTYM_HOST}`;

export function getTtymUiBase(): string {
  const { protocol, hostname } = window.location;
  if (hostname.startsWith('ttym-ui.')) return `${protocol}//${hostname}`;
  if (hostname.startsWith('ttym.')) return `${protocol}//ttym-ui.${hostname.slice(5)}`;
  return 'http://ttym-ui.lullu.lan';
}

export function getSessionUrl(sessionId: number): string {
  return `${getTtymUiBase()}/#s/${sessionId}`;
}

export async function copySessionUrl(sessionId: number) {
  const url = getSessionUrl(sessionId);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(url);
    return;
  }

  const input = document.createElement('input');
  input.value = url;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  document.body.removeChild(input);
}

export async function fetchSessionMeta(sessionId: number): Promise<SessionMeta> {
  return api.getSessionMeta(API_BASE, sessionId);
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  try {
    return await api.listWorkspaces(API_BASE) as Workspace[];
  } catch { return []; }
}

export async function apiReorderWorkspaces(ids: string[]): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/workspaces/order`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
  } catch { /* 실패 시 다음 push가 서버 순서로 되돌린다 — 낙관적 UI의 안전망 */ }
}

export async function apiCreateWorkspace(ws: { id: string; name: string; layout: LayoutNode }): Promise<Workspace | null> {
  try {
    return await api.createWorkspace(API_BASE, { id: ws.id, name: ws.name, layout: ws.layout }) as Workspace;
  } catch { return null; }
}

/** 셸에 안전하게 꽂을 경로: 평범한 문자만이 아니면 따옴표로 감싼다.
 *  ghostty는 백슬래시, vibetunnel은 따옴표를 쓰는데 하류(claude 복원기)는
 *  둘 다 처리한다 — 읽기 좋은 따옴표 쪽을 따른다. */
export function quotePathForShell(path: string): string {
  return /^[A-Za-z0-9_\-./~]+$/.test(path) ? path : `"${path.replace(/"/g, '\\"')}"`;
}

/** 드롭된 File들을 서버 drops/로 올리고 실경로 목록을 받는다 (웹 전용 —
 *  브라우저는 원본 경로를 원리적으로 숨기므로 내용이 대신 여행한다). */
export async function uploadDroppedFiles(files: File[]): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    const res = await fetch(`${API_BASE}/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const { path } = await res.json() as { path: string };
    paths.push(path);
  }
  return paths;
}

export function workspaceDisplayLabel(workspace: Workspace): string {
  return workspaceLabel(workspace.project, workspace.name);
}

export function memberLabel(name: string | undefined, sessionId: number): string {
  return name ? `${name} · #${sessionId}` : `#${sessionId}`;
}

export function sessionWorkspaceMembership(workspaces: Workspace[]): Map<number, { workspace: Workspace; memberName?: string }> {
  const membership = new Map<number, { workspace: Workspace; memberName?: string }>();
  for (const workspace of workspaces) {
    const names = memberNameBySession(workspace.members);
    for (const sessionId of layoutToSessionIds(workspace.layout).filter((id) => id > 0)) {
      membership.set(sessionId, { workspace, memberName: names.get(sessionId) });
    }
  }
  return membership;
}

export async function apiUpdateWorkspace(id: string, patch: { name?: string; layout?: LayoutNode }): Promise<void> {
  try {
    await api.updateWorkspace(API_BASE, id, patch);
  } catch {}
}

export async function apiDeleteWorkspace(id: string): Promise<void> {
  try {
    await api.deleteWorkspace(API_BASE, id);
  } catch {}
}

export async function apiRemoveMember(wsId: string, sessionId: number): Promise<void> {
  try {
    await api.removeWorkspaceMember(API_BASE, wsId, sessionId);
  } catch {}
}

export async function apiAddMember(
  wsId: string,
  sessionId: number,
  name: string,
): Promise<Workspace | null> {
  try {
    return await api.addWorkspaceMember(API_BASE, wsId, { sessionId, name }) as Workspace;
  } catch { return null; }
}

export async function apiSplitWorkspace(
  id: string,
  options: { targetSessionId?: number; cwd?: string; cols?: number; rows?: number; name?: string; role?: string; cmd?: string[]; direction?: 'right' | 'left' | 'down' | 'up' } = {},
): Promise<Workspace | null> {
  try {
    const data = await api.splitWorkspace(API_BASE, id, options);
    return (data?.workspace as Workspace) ?? null;
  } catch { return null; }
}

// ───── 해시 라우팅 ─────

export type Route =
  | { page: 'dashboard' }
  | { page: 'overview' }
  | { page: 'session'; id: number }
  | { page: 'viewer'; id: number }
  | { page: 'workspace'; id: string };

export function parseHash(): Route {
  const hash = window.location.hash;
  if (hash === '#overview') return { page: 'overview' };
  const sessionMatch = hash.match(/^#s\/(\d+)$/);
  if (sessionMatch) return { page: 'session', id: parseInt(sessionMatch[1], 10) };
  const viewerMatch = hash.match(/^#v\/(\d+)$/);
  if (viewerMatch) return { page: 'viewer', id: parseInt(viewerMatch[1], 10) };
  const wsMatch = hash.match(/^#w\/(.+)$/);
  if (wsMatch) return { page: 'workspace', id: wsMatch[1] };
  return { page: 'dashboard' };
}

export function navigate(route: Route) {
  switch (route.page) {
    case 'dashboard': window.location.hash = ''; break;
    case 'overview': window.location.hash = 'overview'; break;
    case 'session': window.location.hash = `s/${route.id}`; break;
    case 'viewer': window.location.hash = `v/${route.id}`; break;
    case 'workspace': window.location.hash = `w/${route.id}`; break;
  }
}


export const emptyPaneStyle: React.CSSProperties = {
  height: '100%', width: '100%',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  background: 'var(--bg1)', color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 12, gap: 8,
};

export const tabStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  height: 29,
  padding: '0 13px',
  borderRadius: 7,
  fontSize: 12,
  fontFamily: 'var(--mono)',
  color: 'var(--text-dim)',
  background: 'transparent',
  border: '1px solid transparent',
  cursor: 'pointer',
};

export const stripBtnStyle: React.CSSProperties = {
  ...tabStyle,
  height: 26,
  padding: '0 10px',
  fontSize: 11,
  color: 'var(--text-soft)',
  border: '1px solid var(--line)',
  borderRadius: 6,
};

export const closeBtnStyle: React.CSSProperties = {
  marginLeft: 'auto',
  background: 'none',
  border: 'none',
  color: 'var(--text-dim)',
  cursor: 'pointer',
  fontSize: 14,
  fontFamily: 'var(--mono)',
  lineHeight: 1,
  padding: '0 4px',
  borderRadius: 3,
};

export const miniLinkBtnStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--text-dim)',
  border: '1px solid transparent',
  padding: '1px 5px',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 10,
  borderRadius: 3,
  lineHeight: 1.4,
};

export const actionBtnStyle: React.CSSProperties = {
  background: 'var(--bg2)',
  color: 'var(--text)',
  border: '1px solid #444',
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  borderRadius: 3,
};
