import { READER_KEY_LABEL } from '../reader/toggle-key.js';

/**
 * The two ways to see one session, as a segmented switch: the raw terminal or the conversation laid out to read.
 * `active` is null while neither is showing (a viewer tab is in front). Grid headers and Zen's bar share it.
 */
export function ReaderSwitch({ active, onPick, margin }: {
  active: 'term' | 'reader' | null;
  onPick: (m: 'term' | 'reader') => void;
  margin?: string;
}) {
  return (
    <span style={{ display: 'inline-flex', flexShrink: 0, margin, border: '1px solid var(--line-strong)', borderRadius: 4, overflow: 'hidden', fontFamily: 'var(--mono)', fontSize: 10 }}>
      {(['term', 'reader'] as const).map((m) => (
        <button
          key={m}
          onClick={(e) => { e.stopPropagation(); onPick(m); }}
          title={`${m === 'reader' ? 'the conversation, laid out to read' : 'the raw terminal'} · ${READER_KEY_LABEL}`}
          style={{ padding: '1px 7px', border: 'none', cursor: 'pointer', font: 'inherit', background: active === m ? 'var(--bg1)' : 'transparent', color: active === m ? 'var(--accent)' : 'var(--text-dim)' }}
        >{m}</button>
      ))}
    </span>
  );
}
