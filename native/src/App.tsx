import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal, TerminalMux } from '@ttym/client';
import {
  createWorkspace,
  deleteWorkspace,
  layoutToSessionIds,
  listWorkspaces,
  sessionIdsToLayout,
  updateWorkspace,
  type WorkspaceInfo,
} from './lib/api';
import { ensureLocalServer } from './lib/daemon';

interface PanelState {
  key: string;
  sessionId?: number;
  hasBell?: boolean;
}

interface WorkspaceTab {
  key: string;
  workspaceId: string;
  name: string;
  panels: PanelState[];
  focused: number;
}

const TTYM_UI_BASE = 'http://ttym-ui.lullu.lan';
const DEFAULT_MAX_PANELS = 3;
const MIN_MAX_PANELS = 1;
const MAX_MAX_PANELS = 8;

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

function makeTab(workspaceId: string, name: string, sessionIds: number[] = []): WorkspaceTab {
  return {
    key: crypto.randomUUID(),
    workspaceId,
    name,
    panels: sessionIds.length > 0 ? sessionIds.map((sessionId) => ({ key: crypto.randomUUID(), sessionId })) : [makePanel()],
    focused: 0,
  };
}

function clampFocused(tab: WorkspaceTab): WorkspaceTab {
  if (tab.panels.length === 0) return tab;
  const focused = Math.max(0, Math.min(tab.focused, tab.panels.length - 1));
  return focused === tab.focused ? tab : { ...tab, focused };
}

export function App() {
  const muxRef = useRef<TerminalMux | null>(null);
  const panelRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [port, setPort] = useState<number | null>(null);
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTab, setActiveTab] = useState(0);
  const [ready, setReady] = useState(false);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [maxPanels, setMaxPanels] = useState(readMaxPanels);

  const currentTab = useMemo(() => tabs[activeTab] ?? null, [tabs, activeTab]);

  useEffect(() => {
    const syncFromLocation = () => setMaxPanels(readMaxPanels());
    window.addEventListener('popstate', syncFromLocation);
    return () => window.removeEventListener('popstate', syncFromLocation);
  }, []);

  function workspaceNameForIndex(index: number): string {
    return `workspace ${index + 1}`;
  }

  function tabFromWorkspace(workspace: WorkspaceInfo): WorkspaceTab {
    return makeTab(
      workspace.id,
      workspace.name,
      layoutToSessionIds(workspace.layout).filter((id) => id > 0),
    );
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

        const existing = await listWorkspaces(info.port);
        if (cancelled) return;

        if (existing.length > 0) {
          setTabs(existing.map(tabFromWorkspace));
          setActiveTab(0);
        } else {
          const workspace = await createWorkspace(info.port, workspaceNameForIndex(0), []);
          if (cancelled) return;
          setTabs([tabFromWorkspace(workspace)]);
          setActiveTab(0);
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
      }).catch(() => {});
    }
  }, [tabs, port, workspaceReady]);

  useEffect(() => {
    const tab = tabs[activeTab];
    if (!tab) return;
    const panel = tab.panels[tab.focused];
    if (!panel) return;
    const el = panelRefs.current.get(panel.key);
    el?.querySelector('textarea')?.focus();
  }, [tabs, activeTab]);

  useEffect(() => {
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
  }, [activeTab, tabs]);

  function updateTab(index: number, updater: (tab: WorkspaceTab) => WorkspaceTab) {
    setTabs((prev) => prev.map((tab, i) => (i === index ? clampFocused(updater(tab)) : tab)));
  }

  async function createWorkspaceTab() {
    if (port === null) return;
    setBusy('creating workspace');
    setError(null);
    try {
      const workspace = await createWorkspace(port, workspaceNameForIndex(tabs.length), []);
      setTabs((prev) => {
        const next = [...prev, tabFromWorkspace(workspace)];
        setActiveTab(next.length - 1);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function closeWorkspaceTab(index: number) {
    if (port === null) return;
    const tab = tabs[index];
    if (!tab) return;

    setBusy('closing workspace');
    setError(null);
    try {
      if (tabs.length === 1) {
        const replacement = await createWorkspace(port, workspaceNameForIndex(0), []);
        await deleteWorkspace(port, tab.workspaceId);
        setTabs([tabFromWorkspace(replacement)]);
        setActiveTab(0);
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function addSplit() {
    if (!currentTab) return;
    if (currentTab.panels.length >= maxPanels) return;
    updateTab(activeTab, (tab) => {
      const nextPanels = [...tab.panels, makePanel()];
      return { ...tab, panels: nextPanels, focused: nextPanels.length - 1 };
    });
  }

  function removeFocusedPane() {
    if (!currentTab) return;
    if (currentTab.panels.length <= 1) {
      closeWorkspaceTab(activeTab);
      return;
    }

    updateTab(activeTab, (tab) => {
      const nextPanels = tab.panels.filter((_, i) => i !== tab.focused);
      const nextFocused = Math.min(tab.focused, nextPanels.length - 1);
      return { ...tab, panels: nextPanels, focused: nextFocused };
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

  function handleCreated(panelKey: string, sessionId: number) {
    updateTab(activeTab, (tab) => ({
      ...tab,
      panels: tab.panels.map((panel) => (
        panel.key === panelKey ? { ...panel, sessionId, hasBell: false } : panel
      )),
    }));
  }

  function handleExit(panelKey: string) {
    updateTab(activeTab, (tab) => {
      const nextPanels = tab.panels.filter((panel) => panel.key !== panelKey);
      if (nextPanels.length === 0) {
        return { ...tab, panels: [makePanel()], focused: 0 };
      }
      const nextFocused = Math.min(tab.focused, nextPanels.length - 1);
      return { ...tab, panels: nextPanels, focused: nextFocused };
    });
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

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (settingsOpen && event.key === 'Escape') {
        setSettingsOpen(false);
        return;
      }

      const meta = event.metaKey || event.ctrlKey;
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

      if (key === '\\') {
        event.preventDefault();
        addSplit();
        return;
      }

      if (key === 'w') {
        event.preventDefault();
        removeFocusedPane();
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
  }, [tabs.length, activeTab, currentTab, settingsOpen, maxPanels]);

  function handleMaxPanelsChange(nextValue: number) {
    const next = clampMaxPanels(nextValue);
    writeMaxPanels(next);
    setMaxPanels(next);
  }

  return (
    <div className="app-shell">
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
                  <span className="tab-label">{tab.name || label}</span>
                  {tabs.length > 1 ? (
                    <span
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeWorkspaceTab(index);
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
          <button
            className="chrome-settings"
            onClick={() => setSettingsOpen((open) => !open)}
            title="Workspace settings"
          >
            settings
          </button>
        </div>
      </div>

      {settingsOpen ? (
        <div className="settings-popover" role="dialog" aria-modal="false">
          <div className="settings-popover-title">workspace settings</div>
          <label className="settings-field">
            <span className="settings-label">max panels</span>
            <div className="settings-control">
              <input
                className="settings-input"
                type="number"
                min={MIN_MAX_PANELS}
                max={MAX_MAX_PANELS}
                value={maxPanels}
                onChange={(event) => handleMaxPanelsChange(Number(event.target.value))}
              />
              <span className="settings-hint">query: `maxPanels`</span>
            </div>
          </label>
          <div className="settings-footnote">
            current workspace uses {currentTab?.panels.length ?? 0} / {maxPanels}
          </div>
        </div>
      ) : null}

      <div
        className="workspace-grid"
        style={{
          gridTemplateColumns: `repeat(${Math.min(currentTab?.panels.length ?? 1, maxPanels)}, minmax(0, 1fr))`,
        }}
      >
        {currentTab?.panels.map((panel, index) => {
          const isFocused = index === currentTab.focused;
          return (
            <div
              key={panel.key}
              ref={(el) => {
                if (el) panelRefs.current.set(panel.key, el);
                else panelRefs.current.delete(panel.key);
              }}
              className={isFocused ? 'pane focused' : 'pane'}
              onClick={() => updateTab(activeTab, (tab) => ({ ...tab, focused: index }))}
            >
              <div className="pane-titlebar">
                <span className="pane-title-group">
                  <span className="pane-title">{panel.sessionId !== undefined ? `#${panel.sessionId}` : 'new'}</span>
                  {panel.sessionId !== undefined ? (
                    <button
                      className="pane-copy"
                      onClick={async (event) => {
                        event.stopPropagation();
                        await copySessionUrl(panel.sessionId!);
                      }}
                      title={`Copy ${getSessionUrl(panel.sessionId)}`}
                    >
                      copy
                    </button>
                  ) : null}
                  {panel.hasBell ? <span className="pane-bell" aria-label="Unread terminal bell" /> : null}
                </span>
                {currentTab.panels.length > 1 ? (
                  <button
                    className="pane-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      updateTab(activeTab, (tab) => {
                        const nextPanels = tab.panels.filter((item) => item.key !== panel.key);
                        if (nextPanels.length === 0) {
                          return { ...tab, panels: [makePanel()], focused: 0 };
                        }
                        const nextFocused = Math.min(tab.focused, nextPanels.length - 1);
                        return { ...tab, panels: nextPanels, focused: nextFocused };
                      });
                    }}
                    title="Close pane (Ctrl/Cmd+W)"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <div className="pane-terminal">
                {ready && muxRef.current ? (
                  <Terminal
                    key={panel.key}
                    mux={muxRef.current}
                    attachId={panel.sessionId}
                    onCreated={(sessionId) => handleCreated(panel.key, sessionId)}
                    onExit={() => handleExit(panel.key)}
                    onBell={() => handleBell(panel.key)}
                  />
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
