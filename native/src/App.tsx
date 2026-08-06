import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, TerminalMux, type SessionInfo } from '@ttym/client';
import {
  MutationBarrier,
  formatCwd,
  memberNameBySession,
  reconcileSessionPanels,
  workspaceLabel,
} from '@ttym/shared';
import {
  createWorkspace,
  getSessionMeta,
  deleteWorkspace,
  getSessionScreen,
  layoutToSessionIds,
  listSessions,
  listWorkspaces,
  sessionIdsToLayout,
  splitWorkspace,
  type SessionMeta,
  updateWorkspace,
  type WorkspaceMemberInfo,
  type WorkspaceInfo,
} from './lib/api';
import { ensureLocalServer } from './lib/daemon';
import { createNativeWindow } from './lib/window';

interface PanelState {
  key: string;
  sessionId?: number;
  memberName?: string;
  cwd?: string;
  hasBell?: boolean;
}

interface WorkspaceTab {
  key: string;
  workspaceId: string;
  project: string;
  name: string;
  members: WorkspaceMemberInfo[];
  panels: PanelState[];
  focused: number;
}

interface WorkspacePreview {
  workspaceId: string;
  screens: Record<number, string>;
  updatedAt: number;
}

interface RestoreAction {
  label: string;
  command: string;
}

type AppMode = 'home' | 'workspace';

const TTYM_UI_BASE = 'http://ttym-ui.lullu.lan';
const DEFAULT_MAX_PANELS = 3;
const MIN_MAX_PANELS = 1;
const MAX_MAX_PANELS = 8;
const DEFAULT_ZOOM_LEVEL = 0;
const MIN_ZOOM_LEVEL = -5;
const MAX_ZOOM_LEVEL = 8;
const BASE_TERMINAL_FONT_SIZE = 14;
const DEFAULT_FONT_SMOOTHING = true;

function clampZoomLevel(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM_LEVEL;
  return Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, Math.trunc(value)));
}

function clampMaxPanels(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PANELS;
  return Math.max(MIN_MAX_PANELS, Math.min(MAX_MAX_PANELS, Math.trunc(value)));
}

function readMaxPanels(): number {
  const raw = new URLSearchParams(window.location.search).get('maxPanels');
  if (!raw) return DEFAULT_MAX_PANELS;
  return clampMaxPanels(Number(raw));
}

function writeMaxPanels(value: number) {
  const next = clampMaxPanels(value);
  const url = new URL(window.location.href);
  url.searchParams.set('maxPanels', String(next));
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function readFontSmoothing(): boolean {
  const raw = new URLSearchParams(window.location.search).get('fontSmoothing');
  if (!raw) return DEFAULT_FONT_SMOOTHING;
  return raw !== 'off';
}

function writeFontSmoothing(value: boolean) {
  const url = new URL(window.location.href);
  url.searchParams.set('fontSmoothing', value ? 'on' : 'off');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function readAppMode(): AppMode {
  const raw = new URLSearchParams(window.location.search).get('mode');
  return raw === 'workspace' ? 'workspace' : 'home';
}

function writeAppMode(mode: AppMode) {
  const url = new URL(window.location.href);
  if (mode === 'home') url.searchParams.set('mode', 'home');
  else url.searchParams.delete('mode');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function buildWindowSearch(mode: AppMode): string {
  const params = new URLSearchParams(window.location.search);
  if (mode === 'home') params.set('mode', 'home');
  else params.delete('mode');
  const search = params.toString();
  return search ? `?${search}` : '';
}

function getSessionUrl(sessionId: number): string {
  return `${TTYM_UI_BASE}/#s/${sessionId}`;
}

async function copySessionUrl(sessionId: number) {
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

function makePanel(): PanelState {
  return { key: crypto.randomUUID(), hasBell: false };
}

function panelPrimaryLabel(panel: PanelState, fallbackIndex?: number): string {
  if (panel.memberName) return panel.memberName;
  if (panel.sessionId !== undefined) return `#${panel.sessionId}`;
  return fallbackIndex !== undefined ? `pane ${fallbackIndex + 1}` : 'new';
}

function panelSecondaryLabel(panel: PanelState): string | null {
  if (panel.memberName && panel.sessionId !== undefined) return `#${panel.sessionId}`;
  return null;
}

function panelCwd(panel: PanelState | undefined, metas: Record<number, SessionMeta>): string | undefined {
  if (!panel) return undefined;
  if (panel.cwd) return panel.cwd;
  if (panel.sessionId === undefined) return undefined;
  const meta = metas[panel.sessionId];
  return typeof meta?.cwd === 'string' ? meta.cwd : undefined;
}

function insertPanelRight(panels: PanelState[], focused: number, panel: PanelState): { panels: PanelState[]; focus: number } {
  const insertAt = Math.min(Math.max(0, focused + 1), panels.length);
  const nextPanels = [...panels];
  nextPanels.splice(insertAt, 0, panel);
  return { panels: nextPanels, focus: insertAt };
}

function movePanel(panels: PanelState[], fromIndex: number, toIndex: number): PanelState[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= panels.length || toIndex >= panels.length) {
    return panels;
  }
  const next = [...panels];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function makeTab(workspaceId: string, name: string, sessionIds: number[] = []): WorkspaceTab {
  return {
    key: crypto.randomUUID(),
    workspaceId,
    project: 'default',
    name,
    members: [],
    panels: sessionIds.length > 0 ? sessionIds.map((sessionId) => ({ key: crypto.randomUUID(), sessionId })) : [makePanel()],
    focused: 0,
  };
}

function clampFocused(tab: WorkspaceTab): WorkspaceTab {
  if (tab.panels.length === 0) return tab;
  const focused = Math.max(0, Math.min(tab.focused, tab.panels.length - 1));
  return focused === tab.focused ? tab : { ...tab, focused };
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
}

function xterm256Color(code: number): string {
  if (code < 16) {
    const base = [
      '#000000', '#cd3131', '#0dbc79', '#e5e510',
      '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
      '#666666', '#f14c4c', '#23d18b', '#f5f543',
      '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
    ];
    return base[code] ?? '#d8e4f0';
  }
  if (code >= 16 && code <= 231) {
    const n = code - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const channel = [0, 95, 135, 175, 215, 255];
    return `rgb(${channel[r]}, ${channel[g]}, ${channel[b]})`;
  }
  const gray = 8 + (code - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function ansiToHtml(value: string): string {
  let result = '';
  let index = 0;
  let column = 0;
  let fg = '#d8e4f0';
  let bg = 'transparent';
  let bold = false;
  let open = false;

  const close = () => {
    if (open) {
      result += '</span>';
      open = false;
    }
  };

  const openSpan = () => {
    close();
    result += `<span style="color:${fg};background:${bg};font-weight:${bold ? 600 : 400}">`;
    open = true;
  };

  openSpan();

  while (index < value.length) {
    const char = value[index];
    if (char === '\u001b') {
      const cursorForward = /^\u001b\[([0-9]*)C/.exec(value.slice(index));
      if (cursorForward) {
        const amount = Number(cursorForward[1] || '1');
        result += ' '.repeat(Math.max(0, amount));
        column += Math.max(0, amount);
        index += cursorForward[0].length;
        continue;
      }

      const cursorBackward = /^\u001b\[([0-9]*)D/.exec(value.slice(index));
      if (cursorBackward) {
        const amount = Number(cursorBackward[1] || '1');
        column = Math.max(0, column - Math.max(0, amount));
        index += cursorBackward[0].length;
        continue;
      }

      const cursorAbsolute = /^\u001b\[([0-9]*)G/.exec(value.slice(index));
      if (cursorAbsolute) {
        const target = Math.max(0, Number(cursorAbsolute[1] || '1') - 1);
        if (target > column) {
          result += ' '.repeat(target - column);
        }
        column = target;
        index += cursorAbsolute[0].length;
        continue;
      }

      const match = /^\u001b\[([0-9;]*)m/.exec(value.slice(index));
      if (match) {
        const codes = match[1]
          .split(';')
          .filter(Boolean)
          .map((code) => Number(code));
        if (codes.length === 0) codes.push(0);

        for (let i = 0; i < codes.length; i += 1) {
          const code = codes[i];
          if (code === 0) {
            fg = '#d8e4f0';
            bg = 'transparent';
            bold = false;
          } else if (code === 1) {
            bold = true;
          } else if (code === 22) {
            bold = false;
          } else if (code === 39) {
            fg = '#d8e4f0';
          } else if (code === 49) {
            bg = 'transparent';
          } else if (code >= 30 && code <= 37) {
            fg = xterm256Color(code - 30);
          } else if (code >= 90 && code <= 97) {
            fg = xterm256Color(code - 82);
          } else if (code >= 40 && code <= 47) {
            bg = xterm256Color(code - 40);
          } else if (code >= 100 && code <= 107) {
            bg = xterm256Color(code - 92);
          } else if (code === 38 && codes[i + 1] === 5 && typeof codes[i + 2] === 'number') {
            fg = xterm256Color(codes[i + 2]);
            i += 2;
          } else if (code === 48 && codes[i + 1] === 5 && typeof codes[i + 2] === 'number') {
            bg = xterm256Color(codes[i + 2]);
            i += 2;
          }
        }

        openSpan();
        index += match[0].length;
        continue;
      }

      const otherEscape = /^\u001b(?:[@-Z\\-_]|\[[0-9;?]*[ -/]*[@-~])/.exec(value.slice(index));
      if (otherEscape) {
        index += otherEscape[0].length;
        continue;
      }
    }

    if (char === '&') result += '&amp;';
    else if (char === '<') result += '&lt;';
    else if (char === '>') result += '&gt;';
    else if (char === '\n') {
      result += '\n';
      column = 0;
    } else if (char !== '\r') {
      result += char;
      column += 1;
    }
    index += 1;
  }

  close();
  return result;
}

function reconcileWorkspaceTabs(prevTabs: WorkspaceTab[], workspaces: WorkspaceInfo[]): WorkspaceTab[] {
  const prevByWorkspaceId = new Map(prevTabs.map((tab) => [tab.workspaceId, tab]));

  return workspaces.map((workspace) => {
    const prevTab = prevByWorkspaceId.get(workspace.id);
    const sessionIds = layoutToSessionIds(workspace.layout).filter((id) => id > 0);
    const namesBySessionId = memberNameBySession(workspace.members);

    if (!prevTab) {
      return clampFocused({
        ...makeTab(workspace.id, workspace.name, sessionIds),
        project: workspace.project,
        members: workspace.members,
        panels: sessionIds.length > 0
          ? sessionIds.map((sessionId) => ({
            key: crypto.randomUUID(),
            sessionId,
            memberName: namesBySessionId.get(sessionId),
          }))
          : [makePanel()],
      });
    }

    const nextPanels = reconcileSessionPanels(prevTab.panels, sessionIds, {
      createEmpty: () => makePanel(),
      createForSession: (sessionId) => ({
        key: crypto.randomUUID(),
        sessionId,
        memberName: namesBySessionId.get(sessionId),
        hasBell: false,
      }),
      decorateSession: (panel, sessionId) => ({
        ...panel,
        sessionId,
        memberName: namesBySessionId.get(sessionId),
        hasBell: panel.hasBell && panel.sessionId === sessionId,
      }),
      clearUnassigned: (panel) => ({ ...panel, sessionId: undefined, memberName: undefined, hasBell: false }),
    });

    return clampFocused({
      ...prevTab,
      project: workspace.project,
      name: workspace.name,
      members: workspace.members,
      panels: nextPanels,
    });
  });
}

export function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionMetas, setSessionMetas] = useState<Record<number, SessionMeta>>({});
  const [previews, setPreviews] = useState<Record<string, WorkspacePreview>>({});
  const [activeTab, setActiveTab] = useState(0);
  const [ready, setReady] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxPanels, setMaxPanels] = useState(readMaxPanels);
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_ZOOM_LEVEL);
  const [fontSmoothing, setFontSmoothing] = useState(readFontSmoothing);
  const [appMode, setAppMode] = useState<AppMode>(readAppMode);
  const [homeSelection, setHomeSelection] = useState(0);
  const [draggedPanelKey, setDraggedPanelKey] = useState<string | null>(null);
  const mutationBarrierRef = useRef(new MutationBarrier());

  const currentTab = useMemo(() => tabs[activeTab] ?? null, [tabs, activeTab]);
  const terminalFontSize = BASE_TERMINAL_FONT_SIZE + zoomLevel;
  const uiScale = Number((1 + zoomLevel * 0.04).toFixed(3));
  const currentPanelCount = currentTab?.panels.length ?? 0;
  const gridColumns = Math.max(1, Math.min(currentPanelCount || 1, maxPanels));
  const gridRows = Math.max(1, Math.ceil((currentPanelCount || 1) / maxPanels));
  const homeItems = useMemo(
    () => [
      { kind: 'new' as const, id: 'new', title: 'new workspace', meta: 'Press Enter to start' },
      ...tabs.map((tab, index) => ({
        kind: 'workspace' as const,
        id: tab.workspaceId,
        index,
        title: tab.name || `workspace ${index + 1}`,
        meta: `${workspaceLabel(tab.project, tab.name || `workspace ${index + 1}`)} · ${tab.panels.length} pane${tab.panels.length === 1 ? '' : 's'}`,
      })),
    ],
    [tabs],
  );
  const sessionById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  const restoreActionForSession = useMemo(() => {
    return (sessionId?: number): RestoreAction | null => {
      if (sessionId === undefined) return null;
      const meta = sessionMetas[sessionId];
      if (!meta) return null;

      const claudeSid = (meta.claudeLastSessionId || meta.claudeSessionId) as string | undefined | null;
      if (claudeSid) {
        return {
          label: 'restore claude',
          command: `claude --dangerously-skip-permissions --resume ${claudeSid}\r`,
        };
      }

      const codexSid = (meta.codexLastSessionId || meta.codexSessionId) as string | undefined | null;
      if (codexSid) {
        return {
          label: 'restore codex',
          command: `codex --dangerously-bypass-approvals-and-sandbox resume ${codexSid}\r`,
        };
      }

      return null;
    };
  }, [sessionMetas]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const syncFromLocation = () => {
      setMaxPanels(readMaxPanels());
      setFontSmoothing(readFontSmoothing());
      setAppMode(readAppMode());
    };
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  useEffect(() => {
    if (homeSelection >= homeItems.length) {
      setHomeSelection(Math.max(0, homeItems.length - 1));
    }
  }, [homeSelection, homeItems.length]);

  function workspaceNameForIndex(index: number): string {
    return `workspace ${index + 1}`;
  }

  function tabFromWorkspace(workspace: WorkspaceInfo): WorkspaceTab {
    const sessionIds = layoutToSessionIds(workspace.layout).filter((id) => id > 0);
    const namesBySessionId = memberNameBySession(workspace.members);
    return clampFocused({
      ...makeTab(workspace.id, workspace.name, sessionIds),
      project: workspace.project,
      members: workspace.members,
      panels: sessionIds.length > 0
        ? sessionIds.map((id) => ({ key: crypto.randomUUID(), sessionId: id, memberName: namesBySessionId.get(id) }))
        : [makePanel()],
    });
  }

  async function refreshLauncher(portValue: number) {
    const [workspaceList, sessionList] = await Promise.all([
      listWorkspaces(portValue),
      listSessions(portValue).catch(() => []),
    ]);
    setTabs((prev) => reconcileWorkspaceTabs(prev, workspaceList));
    setSessions(sessionList.filter((session) => session.status !== 'dead'));
  }

  async function refreshSessionsOnly(portValue: number) {
    const sessionList = await listSessions(portValue).catch(() => []);
    setSessions(sessionList.filter((session) => session.status !== 'dead'));
  }

  async function refreshWorkspacePreviews(portValue: number, workspaceTabs: WorkspaceTab[], sessionList: SessionInfo[]) {
    const liveSessionIds = new Set(sessionList.filter((session) => session.status !== 'dead').map((session) => session.id));
    const nextEntries = await Promise.all(workspaceTabs.map(async (tab) => {
      const previewIds = tab.panels
        .map((panel) => panel.sessionId)
        .filter((id): id is number => id !== undefined && liveSessionIds.has(id))
        .slice(0, 4);

      const screens = await Promise.all(previewIds.map(async (sessionId) => {
        try {
          const screen = await getSessionScreen(portValue, sessionId);
          return [sessionId, screen] as const;
        } catch {
          return [sessionId, 'unavailable'] as const;
        }
      }));

      return [tab.workspaceId, {
        workspaceId: tab.workspaceId,
        screens: Object.fromEntries(screens),
        updatedAt: Date.now(),
      }] as const;
    }));

    setPreviews((prev) => ({ ...prev, ...Object.fromEntries(nextEntries) }));
  }

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      try {
        const info = await ensureLocalServer();
        if (cancelled) return;

        const mux = new TerminalMux(`ws://127.0.0.1:${info.port}`);
        await mux.connect();
        if (cancelled) {
          mux.disconnect();
          return;
        }

        muxRef.current = mux;
        setPort(info.port);
        setReady(true);

        const [workspaceList, sessionList] = await Promise.all([
          listWorkspaces(info.port),
          listSessions(info.port).catch(() => []),
        ]);
        if (cancelled) return;

        setSessions(sessionList.filter((session) => session.status !== 'dead'));

        if (workspaceList.length > 0) {
          setTabs(workspaceList.map(tabFromWorkspace));
          setActiveTab(0);
        } else if (readAppMode() === 'workspace') {
          const workspace = await createWorkspace(info.port, workspaceNameForIndex(0), []);
          if (cancelled) return;
          setTabs([tabFromWorkspace(workspace)]);
          setActiveTab(0);
        } else {
          setTabs([]);
        }

        setWorkspaceReady(true);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    }

    void boot();

    return () => {
      cancelled = true;
      muxRef.current?.disconnect();
      muxRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!workspaceReady || port === null || tabs.length === 0) return;

    for (const tab of tabs) {
      const sessionIds = tab.panels
        .map((panel) => panel.sessionId)
        .filter((id): id is number => id !== undefined);
      void updateWorkspace(port, tab.workspaceId, {
        name: tab.name,
        layout: sessionIdsToLayout(sessionIds),
        members: tab.members,
      }).catch(() => {});
    }
  }, [tabs, port, workspaceReady]);

  useEffect(() => {
    if (appMode !== 'workspace') return;
    const tab = tabs[activeTab];
    if (!tab) return;
    const panel = tab.panels[tab.focused];
    if (!panel) return;
    const el = panelRefs.current.get(panel.key);
    el?.querySelector('textarea')?.focus();
  }, [tabs, activeTab, appMode]);

  useEffect(() => {
    if (appMode !== 'home' || port === null || !ready) return;
    let cancelled = false;

    const tick = async () => {
      if (mutationBarrierRef.current.isLocked()) return;
      const [workspaceList, sessionList] = await Promise.all([
        listWorkspaces(port),
        listSessions(port).catch(() => []),
      ]);
      if (cancelled) return;

      const liveSessions = sessionList.filter((session) => session.status !== 'dead');
      const reconciledTabs = reconcileWorkspaceTabs(tabsRef.current, workspaceList);
      setTabs(reconciledTabs);
      setSessions(liveSessions);
      void refreshWorkspacePreviews(port, reconciledTabs, liveSessions);
    };

    void tick();
    const interval = window.setInterval(() => { void tick(); }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [appMode, port, ready]);

  useEffect(() => {
    if (appMode !== 'workspace' || port === null || !ready) return;
    let cancelled = false;

    const tick = async () => {
      if (mutationBarrierRef.current.isLocked()) return;
      const hasPendingLocalPane = tabsRef.current.some((tab) => tab.panels.some((panel) => panel.sessionId === undefined));
      if (hasPendingLocalPane) return;

      const [workspaceList, sessionList] = await Promise.all([
        listWorkspaces(port),
        listSessions(port).catch(() => []),
      ]);
      if (cancelled) return;

      setTabs((prev) => reconcileWorkspaceTabs(prev, workspaceList));
      setSessions(sessionList.filter((session) => session.status !== 'dead'));
    };

    const interval = window.setInterval(() => { void tick(); }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [appMode, port, ready]);

  useEffect(() => {
    if (port === null) return;
    const sessionIds = Array.from(new Set(
      tabs.flatMap((tab) => tab.panels.map((panel) => panel.sessionId).filter((id): id is number => id !== undefined)),
    ));
    if (sessionIds.length === 0) return;

    let cancelled = false;
    void Promise.all(sessionIds.map(async (sessionId) => {
      try {
        const meta = await getSessionMeta(port, sessionId);
        return [sessionId, meta] as const;
      } catch {
        return [sessionId, null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setSessionMetas((prev) => {
        const next = { ...prev };
        for (const [sessionId, meta] of entries) {
          if (meta) next[sessionId] = meta;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [tabs, port]);

  useEffect(() => {
    if (appMode !== 'workspace') return;
    setTabs((prev) => {
      const tab = prev[activeTab];
      if (!tab) return prev;
      const focusedPanel = tab.panels[tab.focused];
      if (!focusedPanel?.hasBell) return prev;

      const nextTabs = [...prev];
      nextTabs[activeTab] = {
        ...tab,
        panels: tab.panels.map((panel, index) => (
          index === tab.focused ? { ...panel, hasBell: false } : panel
        )),
      };
      return nextTabs;
    });
  }, [activeTab, tabs, appMode]);

  function updateTab(index: number, updater: (tab: WorkspaceTab) => WorkspaceTab) {
    setTabs((prev) => prev.map((tab, i) => (i === index ? clampFocused(updater(tab)) : tab)));
  }

  function enterWorkspace(index: number) {
    setActiveTab(index);
    setAppMode('workspace');
    writeAppMode('workspace');
  }

  function sessionIdsForTab(tab: WorkspaceTab): number[] {
    return tab.panels
      .map((panel) => panel.sessionId)
      .filter((id): id is number => id !== undefined);
  }

  async function openNativeWindow() {
    await createNativeWindow(buildWindowSearch('home'));
  }

  async function createWorkspaceTab(options?: { enter?: boolean }) {
    if (port === null) return;
    const endMutation = mutationBarrierRef.current.begin();
    setBusy('creating workspace');
    setError(null);
    try {
      const workspace = await createWorkspace(port, workspaceNameForIndex(tabs.length), []);
      setTabs((prev) => {
        const next = [...prev, tabFromWorkspace(workspace)];
        setActiveTab(next.length - 1);
        return next;
      });
      if (options?.enter) {
        setAppMode('workspace');
        writeAppMode('workspace');
      }
      await refreshLauncher(port);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      endMutation();
      setBusy(null);
    }
  }

  async function closeWorkspaceTab(index: number, options?: { terminate?: boolean }) {
    if (port === null) return;
    const tab = tabs[index];
    if (!tab) return;
    const terminate = options?.terminate ?? false;
    const endMutation = mutationBarrierRef.current.begin();

    setBusy(terminate ? 'terminating workspace' : 'detaching workspace');
    setError(null);
    try {
      if (terminate) {
        for (const sessionId of sessionIdsForTab(tab)) {
          muxRef.current?.destroySession(sessionId);
        }
      } else {
        for (const sessionId of sessionIdsForTab(tab)) {
          muxRef.current?.detachSession(sessionId);
        }
      }

      if (tabs.length === 1) {
        await deleteWorkspace(port, tab.workspaceId);
        setTabs([]);
        setActiveTab(0);
        setAppMode('home');
        writeAppMode('home');
      } else {
        await deleteWorkspace(port, tab.workspaceId);
        setTabs((prev) => {
          const next = prev.filter((_, i) => i !== index);
          setActiveTab((current) => {
            if (current > index) return current - 1;
            if (current >= next.length) return next.length - 1;
            return current;
          });
          return next;
        });
      }
      await refreshLauncher(port);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      endMutation();
      setBusy(null);
    }
  }

  function updatePanelsAfterRemoval(tab: WorkspaceTab, index: number): WorkspaceTab {
    const nextPanels = tab.panels.filter((_, i) => i !== index);
    if (nextPanels.length === 0) {
      return { ...tab, panels: [makePanel()], focused: 0 };
    }
    const nextFocused = Math.min(tab.focused, nextPanels.length - 1);
    return { ...tab, panels: nextPanels, focused: nextFocused };
  }

  function removePaneAt(index: number, options?: { terminate?: boolean }) {
    if (!currentTab) return;
    mutationBarrierRef.current.blockFor();
    const panel = currentTab.panels[index];
    if (!panel) return;
    const terminate = options?.terminate ?? false;

    if (panel.sessionId !== undefined) {
      if (terminate) muxRef.current?.destroySession(panel.sessionId);
      else muxRef.current?.detachSession(panel.sessionId);
    }

    updateTab(activeTab, (tab) => updatePanelsAfterRemoval(tab, index));
  }

  function addSplit() {
    if (!currentTab || port === null) return;
    const endMutation = mutationBarrierRef.current.begin();
    const source = currentTab.panels[currentTab.focused];
    void splitWorkspace(port, currentTab.workspaceId, {
      targetSessionId: source?.sessionId,
      cwd: panelCwd(source, sessionMetas),
      cols: 80,
      rows: 24,
    }).then(async ({ workspace }) => {
      const namesBySessionId = memberNameBySession(workspace.members);
      const ids = layoutToSessionIds(workspace.layout).filter((id) => id > 0);
      updateTab(activeTab, (tab) => {
        const nextPanels = reconcileWorkspaceTabs([tab], [workspace])[0]!.panels;
        const targetIndex = source?.sessionId !== undefined ? ids.indexOf(source.sessionId) : -1;
        return {
          ...tab,
          project: workspace.project,
          name: workspace.name,
          members: workspace.members,
          panels: nextPanels.map((panel) => ({
            ...panel,
            memberName: panel.sessionId !== undefined ? namesBySessionId.get(panel.sessionId) : panel.memberName,
          })),
          focused: targetIndex >= 0 ? Math.min(targetIndex + 1, ids.length - 1) : Math.max(0, ids.length - 1),
        };
      });
      await refreshSessionsOnly(port);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      endMutation();
    });
  }

  function movePaneTo(fromKey: string, toIndex: number) {
    updateTab(activeTab, (tab) => {
      const fromIndex = tab.panels.findIndex((panel) => panel.key === fromKey);
      if (fromIndex < 0) return tab;
      const nextPanels = movePanel(tab.panels, fromIndex, toIndex);
      return { ...tab, panels: nextPanels, focused: nextPanels.findIndex((panel) => panel.key === fromKey) };
    });
  }

  function focusPrevPane() {
    if (!currentTab) return;
    updateTab(activeTab, (tab) => ({ ...tab, focused: Math.max(0, tab.focused - 1) }));
  }

  function focusNextPane() {
    if (!currentTab) return;
    updateTab(activeTab, (tab) => ({ ...tab, focused: Math.min(tab.panels.length - 1, tab.focused + 1) }));
  }

  function focusPrevTab() {
    setActiveTab((current) => Math.max(0, current - 1));
  }

  function focusNextTab() {
    setActiveTab((current) => Math.min(tabs.length - 1, current + 1));
  }

  function startPaneAt(index: number) {
    if (!currentTab || port === null) return;
    const endMutation = mutationBarrierRef.current.begin();
    const source = currentTab.panels[index] ?? currentTab.panels[Math.max(0, index - 1)];
    void splitWorkspace(port, currentTab.workspaceId, {
      targetSessionId: source?.sessionId,
      cwd: panelCwd(source, sessionMetas),
      cols: 80,
      rows: 24,
    }).then(async ({ workspace }) => {
      const nextTab = reconcileWorkspaceTabs([currentTab], [workspace])[0]!;
      updateTab(activeTab, () => nextTab);
      setActiveTab(activeTab);
      await refreshSessionsOnly(port);
    }).catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    }).finally(() => {
      endMutation();
    });
  }

  function handleExit(panelKey: string) {
    mutationBarrierRef.current.blockFor();
    updateTab(activeTab, (tab) => {
      const nextPanels = tab.panels.filter((panel) => panel.key !== panelKey);
      if (nextPanels.length === 0) {
        return { ...tab, panels: [makePanel()], focused: 0 };
      }
      const nextFocused = Math.min(tab.focused, nextPanels.length - 1);
      return { ...tab, panels: nextPanels, focused: nextFocused };
    });
    if (port !== null) void refreshLauncher(port).catch(() => {});
  }

  function handleBell(panelKey: string) {
    updateTab(activeTab, (tab) => {
      const panelIndex = tab.panels.findIndex((panel) => panel.key === panelKey);
      if (panelIndex < 0 || panelIndex === tab.focused) return tab;

      const target = tab.panels[panelIndex];
      if (target.hasBell) return tab;

      return {
        ...tab,
        panels: tab.panels.map((panel, index) => (
          index === panelIndex ? { ...panel, hasBell: true } : panel
        )),
      };
    });
  }

  async function submitHomeSelection() {
    const item = homeItems[homeSelection];
    if (!item) return;
    if (item.kind === 'new') {
      await createWorkspaceTab({ enter: true });
      return;
    }
    enterWorkspace(item.index);
  }

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settingsOpen && event.key === 'Escape') {
        setSettingsOpen(false);
        return;
      }

      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void openNativeWindow();
        return;
      }

      if (appMode === 'home') {
        if (event.key === 'Enter') {
          event.preventDefault();
          void submitHomeSelection();
          return;
        }
        if (event.code === 'ArrowUp') {
          event.preventDefault();
          setHomeSelection((current) => Math.max(0, current - 1));
          return;
        }
        if (event.code === 'ArrowDown') {
          event.preventDefault();
          setHomeSelection((current) => Math.min(homeItems.length - 1, current + 1));
        }
        return;
      }

      if (!meta) return;
      const key = event.key.toLowerCase();

      if (key === 't') {
        event.preventDefault();
        void createWorkspaceTab();
        return;
      }

      if (/^[1-9]$/.test(key)) {
        const nextIndex = Number(key) - 1;
        if (nextIndex < tabs.length) {
          event.preventDefault();
          setActiveTab(nextIndex);
        }
        return;
      }

      if (event.code === 'Equal') {
        event.preventDefault();
        setZoomLevel((current) => clampZoomLevel(current + 1));
        return;
      }

      if (event.code === 'Minus') {
        event.preventDefault();
        setZoomLevel((current) => clampZoomLevel(current - 1));
        return;
      }

      if (event.code === 'Digit0') {
        event.preventDefault();
        setZoomLevel(DEFAULT_ZOOM_LEVEL);
        return;
      }

      if (key === '\\') {
        event.preventDefault();
        addSplit();
        return;
      }

      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        focusPrevPane();
        return;
      }

      if (event.code === 'ArrowRight') {
        event.preventDefault();
        focusNextPane();
        return;
      }

      if (event.shiftKey && key === '[') {
        event.preventDefault();
        focusPrevTab();
        return;
      }

      if (event.shiftKey && key === ']') {
        event.preventDefault();
        focusNextTab();
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [appMode, tabs.length, activeTab, currentTab, settingsOpen, maxPanels, homeItems, homeSelection]);

  function handleMaxPanelsChange(nextValue: number) {
    const next = clampMaxPanels(nextValue);
    writeMaxPanels(next);
    setMaxPanels(next);
  }

  function handleFontSmoothingChange(nextValue: boolean) {
    writeFontSmoothing(nextValue);
    setFontSmoothing(nextValue);
  }

  function workspaceAttachState(tab: WorkspaceTab): {
    label: 'attached' | 'detached' | 'empty';
    detail: string;
  } {
    const tabSessions = tab.panels
      .map((panel) => panel.sessionId)
      .filter((id): id is number => id !== undefined)
      .map((id) => sessionById.get(id))
      .filter((session): session is SessionInfo => Boolean(session));

    if (tabSessions.length === 0) {
      return { label: 'empty', detail: 'no live sessions' };
    }

    const attached = tabSessions.filter((session) => session.status === 'attached').length;
    const detached = tabSessions.filter((session) => session.status === 'detached').length;
    if (attached > 0) {
      return { label: 'attached', detail: `${attached} attached${detached > 0 ? ` · ${detached} detached` : ''}` };
    }
    return { label: 'detached', detail: `${detached} detached` };
  }

  if (appMode === 'home') {
    return (
      <div
        className={fontSmoothing ? 'app-shell home-shell' : 'app-shell home-shell font-smoothing-off'}
        style={{ ['--ui-scale' as any]: uiScale }}
      >
        <div className="window-chrome home-chrome">
          <div className="chrome-drag chrome-drag-left" data-tauri-drag-region />
          <div className="home-title" data-tauri-drag-region>ttym native</div>
          <div className="chrome-actions">
            <button className="chrome-settings" onClick={() => setSettingsOpen((open) => !open)} title="Launcher settings">
              settings
            </button>
          </div>
        </div>

        {settingsOpen ? (
          <div className="settings-popover" role="dialog" aria-modal="false">
            <div className="settings-popover-title">launcher settings</div>
            <label className="settings-field">
              <span className="settings-label">max columns</span>
              <div className="settings-control">
                <input
                  className="settings-input"
                  type="number"
                  min={MIN_MAX_PANELS}
                  max={MAX_MAX_PANELS}
                  value={maxPanels}
                  onChange={(event) => handleMaxPanelsChange(Number(event.target.value))}
                />
                <span className="settings-hint">query: `maxPanels` (columns per row)</span>
              </div>
            </label>
            <label className="settings-toggle">
              <span className="settings-label">font smoothing</span>
              <button
                className={fontSmoothing ? 'settings-switch on' : 'settings-switch'}
                type="button"
                onClick={() => handleFontSmoothingChange(!fontSmoothing)}
                aria-pressed={fontSmoothing}
                title="Toggle font smoothing and WebGL terminal rendering"
              >
                <span className="settings-switch-thumb" />
              </button>
            </label>
            <div className="settings-footnote">
              {fontSmoothing ? 'webgl + smoothing on' : 'canvas fallback + smoothing off'}
            </div>
          </div>
        ) : null}

        <div className="home-screen">
          <div className="home-hero">
            <div className="home-kicker">local-first terminal workspace</div>
            <h1 className="home-heading">Start fast.</h1>
            <p className="home-copy">Press Enter to open a new workspace, or jump back into an existing one.</p>
          </div>

          <div className="home-grid">
            <section className="home-panel">
              <div className="home-panel-header">
                <span className="home-panel-title">workspaces</span>
                <span className="home-panel-hint">Enter to open</span>
              </div>
              <div className="home-list">
                {homeItems.map((item, index) => (
                  <button
                    key={item.id}
                    className={index === homeSelection ? 'home-item selected' : 'home-item'}
                    onClick={() => {
                      setHomeSelection(index);
                      void submitHomeSelection();
                    }}
                  >
                    <span className="home-item-main">
                      <span className="home-item-title">{item.title}</span>
                      <span className="home-item-meta">{item.meta}</span>
                    </span>
                    <span className="home-item-action">{item.kind === 'new' ? '+' : 'open'}</span>
                  </button>
                ))}
              </div>
            </section>

            <section className="home-panel">
              <div className="home-panel-header">
                <span className="home-panel-title">overview</span>
                <span className="home-panel-hint">{tabs.length} workspace{tabs.length === 1 ? '' : 's'}</span>
              </div>
              <div className="home-preview-grid">
                {tabs.length === 0 ? (
                  <div className="home-empty">{error ?? busy ?? (ready ? 'no workspaces yet' : 'starting ttym-native...')}</div>
                ) : (
                  tabs.map((tab, index) => {
                    const preview = previews[tab.workspaceId];
                    const attach = workspaceAttachState(tab);
                    const previewPanelCount = Math.max(1, Math.min(tab.panels.length, 4));
                    const previewColumns = Math.max(1, Math.min(previewPanelCount, maxPanels));
                    const previewRows = Math.max(1, Math.ceil(previewPanelCount / maxPanels));

                    return (
                      <div
                        key={tab.workspaceId}
                        className={index === homeSelection - 1 ? 'preview-card selected' : 'preview-card'}
                        onClick={() => {
                          setHomeSelection(index + 1);
                          enterWorkspace(index);
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="preview-card-head">
                          <div className="preview-card-title-group">
                            <span className="preview-card-title">{workspaceLabel(tab.project, tab.name || `workspace ${index + 1}`)}</span>
                            <span className="preview-card-actions">
                              <span className={`preview-badge ${attach.label}`}>{attach.label}</span>
                              <button
                                className="preview-card-close"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void closeWorkspaceTab(index, { terminate: true });
                                }}
                                title="Terminate workspace"
                              >
                                ×
                              </button>
                            </span>
                          </div>
                          <span className="preview-card-meta">{workspaceLabel(tab.project, tab.name)} · {attach.detail}</span>
                        </div>
                        <div
                          className="preview-card-grid"
                          style={{
                            gridTemplateColumns: `repeat(${previewColumns}, minmax(0, 1fr))`,
                            gridTemplateRows: `repeat(${previewRows}, minmax(0, 1fr))`,
                          }}
                        >
                          {tab.panels.length === 0 ? (
                            <div className="preview-pane empty">new workspace</div>
                          ) : (
                            tab.panels.slice(0, 4).map((panel, paneIndex) => (
                              <div key={panel.key} className="preview-pane">
                                <div className="preview-pane-bar">
                                  <span>{panelPrimaryLabel(panel, paneIndex)}</span>
                                  {panelSecondaryLabel(panel) ? <span className="preview-pane-meta">{panelSecondaryLabel(panel)}</span> : null}
                                </div>
                                {panel.sessionId !== undefined ? (
                                  <div
                                    className="preview-pane-screen"
                                    dangerouslySetInnerHTML={{ __html: ansiToHtml(preview?.screens[panel.sessionId] ?? 'loading preview...') }}
                                  />
                                ) : (
                                  <div className="preview-pane-screen empty">new pane</div>
                                )}
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={fontSmoothing ? 'app-shell' : 'app-shell font-smoothing-off'}
      style={{ ['--ui-scale' as any]: uiScale }}
    >
      <div className="window-chrome">
        <div className="chrome-drag chrome-drag-left" data-tauri-drag-region />
        <div className="chrome-tabs">
          <div className="tab-strip">
            {tabs.map((tab, index) => {
              const label = `workspace ${index + 1}`;
              return (
                <button
                  key={tab.key}
                  className={index === activeTab ? 'tab-button active' : 'tab-button'}
                  onClick={() => setActiveTab(index)}
                >
                  <span className="tab-label">{workspaceLabel(tab.project, tab.name || label)}</span>
                  {tabs.length > 1 ? (
                    <span
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeWorkspaceTab(index, { terminate: true });
                      }}
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              );
            })}
            <button className="tab-add" onClick={() => void createWorkspaceTab()} title="New workspace tab (Ctrl/Cmd+T)">
              +
            </button>
          </div>
        </div>
        <div className="chrome-actions">
          {currentTab ? (
            <button className="chrome-settings" onClick={() => void closeWorkspaceTab(activeTab)} title="Detach workspace sessions">
              detach
            </button>
          ) : null}
          <button className="chrome-settings" onClick={() => setSettingsOpen((open) => !open)} title="Workspace settings">
            settings
          </button>
        </div>
      </div>

      {settingsOpen ? (
        <div className="settings-popover" role="dialog" aria-modal="false">
          <div className="settings-popover-title">workspace settings</div>
          <label className="settings-field">
            <span className="settings-label">max columns</span>
            <div className="settings-control">
              <input
                className="settings-input"
                type="number"
                min={MIN_MAX_PANELS}
                max={MAX_MAX_PANELS}
                value={maxPanels}
                onChange={(event) => handleMaxPanelsChange(Number(event.target.value))}
              />
              <span className="settings-hint">query: `maxPanels` (columns per row)</span>
            </div>
          </label>
          <div className="settings-footnote">
            current workspace uses {currentPanelCount} pane{currentPanelCount === 1 ? '' : 's'} across {gridRows} row{gridRows === 1 ? '' : 's'}
          </div>
          <label className="settings-toggle">
            <span className="settings-label">font smoothing</span>
            <button
              className={fontSmoothing ? 'settings-switch on' : 'settings-switch'}
              type="button"
              onClick={() => handleFontSmoothingChange(!fontSmoothing)}
              aria-pressed={fontSmoothing}
              title="Toggle font smoothing and WebGL terminal rendering"
            >
              <span className="settings-switch-thumb" />
            </button>
          </label>
          <div className="settings-footnote">
            {fontSmoothing ? 'webgl + smoothing on' : 'canvas fallback + smoothing off'}
          </div>
        </div>
      ) : null}

      <div
        className="workspace-grid"
        style={{
          gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
        }}
      >
        {currentTab?.panels.map((panel, index) => {
          const isFocused = index === currentTab.focused;
          const panelSessionId = panel.sessionId;
          const restoreAction = restoreActionForSession(panelSessionId);
          return (
            <div
              key={panel.key}
              ref={(el) => {
                if (el) panelRefs.current.set(panel.key, el);
                else panelRefs.current.delete(panel.key);
              }}
              className={isFocused ? 'pane focused' : 'pane'}
              onClick={() => updateTab(activeTab, (tab) => ({ ...tab, focused: index }))}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!draggedPanelKey) return;
                movePaneTo(draggedPanelKey, index);
                setDraggedPanelKey(null);
              }}
            >
              <div
                className="pane-titlebar"
                draggable
                onDragStart={() => setDraggedPanelKey(panel.key)}
                onDragEnd={() => setDraggedPanelKey(null)}
              >
                <span className="pane-title-group">
                  <span className="pane-title-row">
                    <span className="pane-title">{panelPrimaryLabel(panel, index)}</span>
                    {panelSecondaryLabel(panel) ? (
                      <span className="pane-title-meta">{panelSecondaryLabel(panel)}</span>
                    ) : null}
                    {panelCwd(panel, sessionMetas) ? (
                      <span className="pane-cwd" title={panelCwd(panel, sessionMetas)}>
                        {formatCwd(panelCwd(panel, sessionMetas))}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="pane-actions">
                  {panel.hasBell ? <span className="pane-bell" aria-label="Unread terminal bell" /> : null}
                  {panelSessionId !== undefined && restoreAction ? (
                    <button
                      className="pane-copy"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!panelSessionId) return;
                        muxRef.current?.send(panelSessionId, restoreAction.command);
                      }}
                      title={restoreAction.command.trim()}
                    >
                      {restoreAction.label}
                    </button>
                  ) : null}
                  {panelSessionId !== undefined ? (
                    <button
                      className="pane-copy"
                      onClick={(event) => {
                        event.stopPropagation();
                        removePaneAt(index);
                      }}
                      title="Detach pane"
                    >
                      detach
                    </button>
                  ) : null}
                  {panelSessionId !== undefined ? (
                    <button
                      className="pane-copy"
                      onClick={async (event) => {
                        event.stopPropagation();
                        await copySessionUrl(panelSessionId);
                      }}
                      title={`Copy ${getSessionUrl(panelSessionId)}`}
                    >
                      copy
                    </button>
                  ) : null}
                </span>
                <button
                  className="pane-close"
                  onClick={(event) => {
                    event.stopPropagation();
                    removePaneAt(index, { terminate: true });
                  }}
                  title="Terminate pane"
                >
                  ×
                </button>
              </div>
              <div className="pane-terminal">
                {ready && muxRef.current && panel.sessionId !== undefined ? (
                  <Terminal
                    key={panel.key}
                    mux={muxRef.current}
                    attachId={panel.sessionId}
                    fontSize={terminalFontSize}
                    enableWebgl={fontSmoothing}
                    onExit={() => handleExit(panel.key)}
                    onBell={() => handleBell(panel.key)}
                  />
                ) : ready && panel.sessionId === undefined ? (
                  <div className="pane-empty">
                    <button className="home-primary" onClick={() => startPaneAt(index)}>start terminal</button>
                  </div>
                ) : (
                  <div className="pane-empty">
                    {error ?? busy ?? (ready ? `daemon :${port}` : 'starting ttym-native...')}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
