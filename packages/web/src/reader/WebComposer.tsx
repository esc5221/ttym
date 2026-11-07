import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as api from '@ttym/api';
import { getHost } from '@ttym/ui';
import { API_BASE, uploadDroppedFiles, quotePathForShell } from '../app-shared.js';
import type { DockView } from './dock.js';
import { keyToBytes, isTextEditingKey, menuToken, applyCompletion, type MenuToken } from './composer-keys.js';
import { composerExtra, updateComposer, useComposerState } from './composerStore.js';

/**
 * The reader's input box: a real text field in the page, in front of the agent's own prompt.
 *
 * Who holds the text being written:
 *   mirror  the field is empty of its own; it shows what is in the agent's prompt (read off the screen —
 *           a history entry ↑ brought back, a queued message pulled back to edit, a transcript of
 *           dictation). Keys with no text of ours go to the agent as they are, so ↑ ↓ Tab → do what
 *           they do there, whatever the person has bound them to.
 *   owned   the person edits in the field. The first edit of mirrored text takes it over: the field keeps
 *           it and the agent's prompt is emptied (Ctrl+U, which never writes history the way Esc Esc does).
 *
 * A key the field has no use for (Ctrl/Alt chords, Shift+Tab) goes to the agent. If there is text of ours, it
 * is first typed into the agent's prompt (no Enter), so a chord that works on the prompt — stash, external
 * editor, send-now — has the text to work on. ttym keeps no table of what each chord means.
 *
 * Enter sends through the server's submit path (pieces, then Enter, checked; server/src/submit.ts).
 */

export interface ComposerHandle { focus(): void }

/** Rows of mirrored text that hold something only the agent can expand. */
const CHIP = /\[(?:Pasted text|Image|Truncated text) #\d+/;

interface Item { insert: string; label: string; detail?: string; submitAfter?: boolean }

export const WebComposer = forwardRef<ComposerHandle, {
  sid: number;
  view: Extract<DockView, { kind: 'prompt' }>;
  /** The agent is in a turn: Esc interrupts it. */
  busy: boolean;
  /** Messages known word for word (this conversation's prompts and queue), to restore one the agent shows wrapped. */
  known?: readonly string[];
  /** The field's height in px whenever it changes, so the page can take a tall draft into its own scroll. */
  onHeight?: (px: number) => void;
}>(function WebComposer({ sid, view, busy, known = [], onHeight }, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => area.current?.focus({ preventScroll: true }) }), []);
  const extra = composerExtra(sid);

  // The agent wraps a long line itself, so its rows are not the text's lines: joined with newlines they would add
  // breaks the message never had. One row is exact. More rows are matched, spaces aside, against messages known
  // word for word; with no match the text stays the agent's and keys go to it (pass-through).
  const shown = view.lines.join('\n');
  const exact = useMemo(() => {
    if (view.lines.length <= 1) return shown;
    const squash = (t: string) => t.replace(/\s+/g, '');
    const want = squash(shown);
    for (const k of [...extra.sent].reverse().concat([...known].reverse())) if (squash(k) === want) return k;
    return null;
  }, [shown, known]);
  const mirror = exact ?? shown;
  const mirrorHasChip = CHIP.test(mirror) || exact === null;
  const mirrorRef = useRef({ text: mirror, lines: view.lines.length });
  mirrorRef.current = { text: mirror, lines: view.lines.length };
  // Draft and messages on their way live outside the component (composerStore): the field is remounted when the
  // agent repaints or a dialog comes and goes, and must not lose either. While a message is on its way (~1 s) the
  // field is ours and empty: mirroring would show the text being typed, and an edit would take it over and erase it.
  const { draft, pending } = useComposerState(sid);
  const setDraft = useCallback((d: string | null | ((cur: string | null) => string | null)) => {
    updateComposer(sid, (s) => ({ draft: typeof d === 'function' ? d(s.draft) : d }));
  }, [sid]);
  const setPending = useCallback((f: (n: number) => number) => updateComposer(sid, (s) => ({ pending: f(s.pending) })), [sid]);
  const owned = draft !== null || pending > 0;
  const value = draft ?? (pending > 0 ? '' : mirror);
  const [note, setNote] = useState<string | null>(null);
  const lastEsc = useRef(0);

  const send = useCallback((bytes: string) => { getHost(sid)?.term.input(bytes); }, [sid]);

  /**
   * Empty the agent's prompt without touching its history (Esc Esc would write it there). Its caret can be anywhere
   * (↑ moves it): Ctrl+K kills to the line's end and, at an end, joins the next line; Ctrl+U the same towards the start.
   * Enough of each clears every line (measured on Claude Code 2.1.319, caret mid-text of four lines).
   */
  const clearAgentPrompt = useCallback((lines: number) => {
    const n = lines * 2 + 2;
    send('\x0b'.repeat(n) + '\x15'.repeat(n));
  }, [send]);

  /** Give the agent our text (typed, no Enter) and go back to mirroring. */
  const handOff = useCallback(async () => {
    const text = draft;
    setDraft(null);
    if (text) {
      extra.sent = [...extra.sent.slice(-19), text];
      await api.submitToSession(API_BASE, sid, text, 'none').catch(() => {});
    }
  }, [draft, sid, setDraft]);

  // Back after a remount: the caret where it was, and the keyboard if the field had it. Whether it had it is kept
  // as focus comes and goes — by the time an unmount's cleanup runs the element is already out of the page, and a
  // removed element sends no blur, so the last word stands.
  useEffect(() => {
    const el = area.current;
    if (el && extra.focused) {
      el.focus({ preventScroll: true });
      const at = Math.min(extra.caret ?? el.value.length, el.value.length);
      el.setSelectionRange(at, at);
    }
  }, []);

  // As tall as its text, wrapped lines included; nothing scrolls inside it. A draft taller than the page allows
  // goes into the page (ReaderView), whose own scroll then carries it.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
      onHeight?.(el.getBoundingClientRect().height);
    };
    fit();
    const ro = new ResizeObserver(() => fit());
    ro.observe(el.parentElement ?? el);
    return () => ro.disconnect();
  }, [value, onHeight]);

  // Keep the caret where the agent's is while mirroring, so a taken-over edit lands where the person expects.
  useEffect(() => {
    if (owned || !area.current || document.activeElement !== area.current) return;
    const el = area.current;
    let at = mirror.length;
    if (view.caret) {
      const before = view.lines.slice(0, view.caret.line).reduce((n, l) => n + l.length + 1, 0);
      at = Math.min(mirror.length, before + Math.min(view.lines[view.caret.line]?.length ?? 0, view.caret.col));
    }
    el.setSelectionRange(at, at);
  }, [mirror, owned, view.caret?.line, view.caret?.col]);

  // ───── completion (/ commands, @ files and agents) ─────
  const [catalog, setCatalog] = useState<api.ComposerCatalog | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [menuClosed, setMenuClosed] = useState<string | null>(null);
  const token: MenuToken | null = owned ? menuToken(value, caret) : null;
  // Asked as soon as the field shows: the first answer for a folder takes ~10 s (two Claudes are asked), and
  // the person should not wait for it at their first "/". The server keeps it after that.
  useEffect(() => {
    let live = true;
    api.getComposerCatalog(API_BASE, sid).then((c) => { if (live) setCatalog(c); }, () => {});
    return () => { live = false; };
  }, [sid]);
  useEffect(() => {
    if (token?.kind !== 'file') return;
    let live = true;
    const t = setTimeout(() => {
      api.getComposerFiles(API_BASE, sid, token.query).then((r) => { if (live) setFiles(r.files); }, () => {});
    }, 80);
    return () => { live = false; clearTimeout(t); };
  }, [token?.kind, token?.query, sid]);

  const items: Item[] = useMemo(() => {
    if (!token) return [];
    const q = token.query.toLowerCase();
    if (token.kind === 'command') {
      const all = catalog?.commands ?? [];
      const starts = all.filter((c) => c.name.slice(1).toLowerCase().startsWith(q));
      const contains = all.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q));
      return [...starts, ...contains].slice(0, 12).map((c) => ({
        insert: `${c.name} `, label: c.name, detail: [c.argumentHint, c.description].filter(Boolean).join(' · '),
        submitAfter: !c.argumentHint,
      }));
    }
    const agents = (catalog?.agents ?? [])
      .filter((a) => `agent-${a.name}`.toLowerCase().includes(q))
      .slice(0, 4)
      .map((a) => ({ insert: `@agent-${a.name} `, label: `@agent-${a.name}`, detail: a.description }));
    const fileItems = files.slice(0, 12).map((f) => ({ insert: `@${quotePathForShell(f)} `, label: f }));
    return [...fileItems, ...agents];
  }, [token?.kind, token?.query, catalog, files]);
  const menuKey = token ? `${token.kind}:${token.start}` : null;
  const menuOpen = items.length > 0 && menuKey !== menuClosed;
  useEffect(() => { setPick(0); }, [token?.kind, token?.query]);

  const accept = (item: Item, thenSubmit: boolean) => {
    if (!token) return;
    const { text, caret: at } = applyCompletion(value, token, item.insert);
    setDraft(text);
    requestAnimationFrame(() => area.current?.setSelectionRange(at, at));
    setCaret(at);
    if (thenSubmit) void submit(text);
  };

  // ───── sending ─────
  // The field empties at once so the next message can be written while this one goes; sends go one after another.
  const submit = (text: string) => {
    if (!text.trim()) return;
    setDraft(null);
    setNote(null);
    setPending((n) => n + 1);
    extra.chain = extra.chain.then(async () => {
      try {
        // Text can reach the agent's prompt after we took over (a ↑ answered late, someone typing in the terminal):
        // the server would send it along with ours, glued on. Empty it first and say so.
        const stray = mirrorRef.current.text === extra.takenOver ? { text: '', lines: 0 } : mirrorRef.current;
        if (stray.text) {
          clearAgentPrompt(stray.lines);
          await new Promise((r) => setTimeout(r, 120));
        }
        extra.takenOver = '';
        extra.sent = [...extra.sent.slice(-19), text];
        const r = await api.submitToSession(API_BASE, sid, text, 'cr');
        if (stray.text) setNote(`Cleared what was in the agent's prompt before sending: “${stray.text.slice(0, 60)}${stray.text.length > 60 ? '…' : ''}”`);
        // Still in the agent's prompt: it shows here again (mirror) rather than as a second copy; Enter tries again.
        if (r.submitted === false) setNote('The agent has not taken the message — it is still in its prompt; press Enter to try again.');
      } catch (e) {
        setNote(`Not sent: ${(e as Error).message}`);
        setDraft((d) => (d ? `${text}\n${d}` : text));
      } finally {
        setPending((n) => n - 1);
      }
    });
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setCaret(e.target.selectionStart ?? next.length);
    extra.caret = e.target.selectionStart;
    if (!owned) {
      // Taking over what the agent's prompt held.
      if (mirror) { clearAgentPrompt(view.lines.length); extra.takenOver = mirror; }
      setDraft(next);
      return;
    }
    setDraft(next === '' ? null : next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === 'Process') return;
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

    if (menuOpen) {
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setPick((p) => (p + 1) % items.length); return; }
      if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setPick((p) => (p - 1 + items.length) % items.length); return; }
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); accept(items[pick]!, false); return; }
      if (e.key === 'Enter' && plain) { e.preventDefault(); const it = items[pick]!; accept(it, token?.kind === 'command' && !!it.submitAfter && token.start === 0); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMenuClosed(menuKey); return; }
    }

    // Text the agent holds that can't be taken over as it is (a chip only it can expand, a wrapped message not
    // known word for word): every key goes to it, as in the terminal.
    if (!owned && mirrorHasChip) {
      if (e.metaKey) return;
      const bytes = keyToBytes(e.nativeEvent);
      if (bytes !== null) { e.preventDefault(); send(bytes); }
      return;
    }

    if (e.key === 'Enter' && plain) {
      e.preventDefault();
      if (owned) void submit(value);
      else send('\r'); // whatever the agent's prompt holds (or a suggestion it shows) is the agent's to send
      return;
    }

    // Option+Enter: a new line too (the agent's own binding for it); a text field does not insert one by itself.
    if (e.key === 'Enter' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
      return;
    }

    if (e.key === 'Escape' && plain) {
      e.preventDefault();
      if (busy || !owned) { send('\x1b'); return; }
      // Ours to clear: twice, as in the terminal, and nothing goes into the agent's history.
      const now = Date.now();
      if (now - lastEsc.current < 800) { setDraft(null); lastEsc.current = 0; setNote(null); }
      else { lastEsc.current = now; setNote('Esc again to clear'); setTimeout(() => setNote((n) => (n === 'Esc again to clear' ? null : n)), 800); }
      return;
    }

    // Space on an empty prompt is the agent's: held down it is push-to-talk (voice dictation), tapped it is a space
    // that comes back through the mirror. Key repeats go too — that is what "held" is to a terminal.
    if (!owned && !mirror && e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      send(' ');
      return;
    }
    if (!owned && plain && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Tab' || (e.key === 'ArrowRight' && !mirror))) {
      e.preventDefault();
      send(keyToBytes(e.nativeEvent)!);
      return;
    }
    if (owned && e.key === 'Tab' && plain) { e.preventDefault(); return; }

    if (owned && e.ctrlKey && !e.metaKey && !e.altKey) {
      // Readline's own erase keys act on our text, where the person is typing.
      const el = e.currentTarget;
      const s = el.selectionStart ?? 0;
      if (e.key === 'u') { e.preventDefault(); const ls = value.lastIndexOf('\n', s - 1) + 1; setDraft(value.slice(0, ls) + value.slice(s) || null); requestAnimationFrame(() => el.setSelectionRange(ls, ls)); return; }
      if (e.key === 'w') { e.preventDefault(); const m = /\S*\s*$/.exec(value.slice(0, s)); const ws = s - (m?.[0].length ?? 0); setDraft(value.slice(0, ws) + value.slice(s) || null); requestAnimationFrame(() => el.setSelectionRange(ws, ws)); return; }
      if (e.key === 'c') { e.preventDefault(); setDraft(null); return; } // as the agent does with text in its prompt
    }

    if (isTextEditingKey(e.nativeEvent)) return;
    const bytes = keyToBytes(e.nativeEvent);
    if (bytes === null) return;
    e.preventDefault();
    if (owned && draft) void handOff().then(() => send(bytes));
    else send(bytes);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    e.preventDefault();
    const el = e.currentTarget;
    const at = el.selectionStart ?? value.length;
    setNote('Uploading image…');
    uploadDroppedFiles(images).then((paths) => {
      const ins = paths.map(quotePathForShell).join(' ') + ' ';
      const base = owned ? value : '';
      if (!owned && mirror) { clearAgentPrompt(view.lines.length); extra.takenOver = mirror; }
      const text = (owned ? base.slice(0, at) : mirror) + ins + (owned ? base.slice(at) : '');
      setDraft(text);
      setNote(null);
    }, (err) => setNote(`Image not uploaded: ${(err as Error).message}`));
  };

  const placeholder = !owned && !mirror ? (view.placeholder ?? (busy ? 'Queue a message…' : 'Message')) : undefined;

  return (
    <div className={`rd-wc${busy ? ' busy' : ''}${owned ? ' owned' : ''}`} data-sid={sid}>
      {menuOpen ? (
        <div className="rd-wc-menu" role="listbox">
          {items.map((it, i) => (
            <div key={it.label} role="option" aria-selected={i === pick} className={`rd-wc-item${i === pick ? ' sel' : ''}`}
              onMouseDown={(ev) => { ev.preventDefault(); accept(it, false); }}>
              <span className="rd-wc-label">{it.label}</span>
              {it.detail ? <span className="rd-wc-detail">{it.detail}</span> : null}
            </div>
          ))}
          {token?.kind === 'command' && !catalog ? <div className="rd-wc-item rd-wc-detail">Asking Claude for its commands…</div> : null}
        </div>
      ) : token?.kind === 'command' && !catalog ? <div className="rd-wc-menu"><div className="rd-wc-item rd-wc-detail">Asking Claude for its commands…</div></div> : null}
      <div className="rd-wc-box">
        <span className="rd-wc-pm">{value.startsWith('!') ? '!' : '❯'}</span>
        <textarea
          ref={area}
          className="rd-wc-input"
          value={value}
          rows={1}
          placeholder={placeholder}
          spellCheck={false}
          readOnly={!owned && mirrorHasChip}
          onCompositionEnd={(ev) => { if (!owned && mirrorHasChip && ev.data) send(ev.data); }}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onSelect={(e) => { setCaret(e.currentTarget.selectionStart ?? 0); extra.caret = e.currentTarget.selectionStart; }}
          onFocus={() => { extra.focused = true; }}
          onBlur={() => { extra.focused = false; }}
          onPaste={onPaste}
          aria-label="Message to the agent"
        />
        {!owned && view.ghost ? <span className="rd-wc-ghost">{view.ghost}</span> : null}
      </div>
      <div className="rd-meta">
        {note ? <div className="rd-meta-row rd-wc-note"><span>{note}</span></div> : null}
        {view.status.map((parts, i) => <div key={i} className="rd-meta-row">{parts.map((p, j) => <span key={j}>{p}</span>)}</div>)}
      </div>
    </div>
  );
});
