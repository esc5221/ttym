import type { ViewItem } from '@ttym/api';
import { miniLinkBtnStyle } from '../app-shared.js';

/** Two tabs with the same basename get their parent folder as a hint. */
export function tabLabel(item: ViewItem, items: ViewItem[]): string {
  if (item.kind === 'url') return item.name;
  const twins = items.filter((other) => other.kind !== 'url' && other.name === item.name);
  if (twins.length <= 1) return item.name;
  const parts = item.target.split('/').filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${item.name}` : item.name;
}

export function ViewerTabs({ items, activeId, onSelect, onClose, trailing }: {
  items: ViewItem[];
  activeId: string | null;
  onSelect: (vid: string) => void;
  onClose: (vid: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="viewer-tabs">
      <div className="viewer-tabs-scroll">
        {items.map((item) => {
          const on = item.id === activeId;
          return (
            <span
              key={item.id}
              className={`viewer-tab${on ? ' on' : ''}`}
              onClick={() => onSelect(item.id)}
              title={item.target}
            >
              <span className="viewer-tab-label">{tabLabel(item, items)}</span>
              <button
                className="viewer-tab-x"
                onClick={(e) => { e.stopPropagation(); onClose(item.id); }}
                title="close tab"
              >×</button>
            </span>
          );
        })}
      </div>
      {trailing ? <span className="viewer-tabs-trailing">{trailing}</span> : null}
    </div>
  );
}

export const viewerBtnStyle: React.CSSProperties = { ...miniLinkBtnStyle, fontSize: 11 };
