import { useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { viewSrc } from '../content.js';

/** An <img>, which is also why SVG lands here: as an image it runs no script. */
export function ImageView({ item }: { item: ViewItem }) {
  const [dims, setDims] = useState<string>('');
  return (
    <div className="viewer-image">
      <img
        src={viewSrc(item)}
        alt={item.name}
        onLoad={(e) => { const img = e.currentTarget; setDims(`${img.naturalWidth}×${img.naturalHeight}`); }}
      />
      <div className="meta">{item.name}{dims ? ` · ${dims}` : ''}</div>
    </div>
  );
}
