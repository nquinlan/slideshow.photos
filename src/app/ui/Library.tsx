import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Photo } from '../db/db';
import { thumbUrl } from './thumbs';

interface Props {
  photos: Photo[];
  selected: Set<string>;
  onSelectionChange(next: Set<string>): void;
  onPlayFrom(photoId: string): void;
}

const MIN_TILE = 132;
const GAP = 6;

/**
 * Virtualized thumbnail grid (rows are windowed against page scroll), so a
 * 5,000-photo collection renders only the ~10 rows in view. Each tile is a
 * real checkbox for selection (keyboard + screen-reader friendly) plus a
 * "play from here" button. Shift-click selects a range.
 */
export function Library({ photos, selected, onSelectionChange, onPlayFrom }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [offset, setOffset] = useState(0);
  const lastClicked = useRef<number>(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setOffset(el.getBoundingClientRect().top + window.scrollY);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(2, Math.floor((width + GAP) / (MIN_TILE + GAP)));
  const tile = (width - GAP * (cols - 1)) / cols;
  const rows = Math.ceil(photos.length / cols);

  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => tile + GAP,
    overscan: 4,
    scrollMargin: offset,
  });

  useEffect(() => virtualizer.measure(), [tile, virtualizer]);

  const toggle = (index: number, shift: boolean) => {
    const next = new Set(selected);
    const id = photos[index].id;
    if (shift && lastClicked.current >= 0) {
      const [a, b] = [lastClicked.current, index].sort((x, y) => x - y);
      const on = !selected.has(id);
      for (let i = a; i <= b; i++) on ? next.add(photos[i].id) : next.delete(photos[i].id);
    } else if (next.has(id)) next.delete(id);
    else next.add(id);
    lastClicked.current = index;
    onSelectionChange(next);
  };

  return (
    <div ref={ref} className="library" style={{ height: virtualizer.getTotalSize() }} role="list" aria-label="Photos">
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={row.key}
          className="library-row"
          style={{
            transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
            gridTemplateColumns: `repeat(${cols}, ${tile}px)`,
            gap: GAP,
          }}
        >
          {photos.slice(row.index * cols, row.index * cols + cols).map((p, i) => {
            const index = row.index * cols + i;
            return (
              <Tile
                key={p.id}
                photo={p}
                size={tile}
                checked={selected.has(p.id)}
                onToggle={(shift) => toggle(index, shift)}
                onPlay={() => onPlayFrom(p.id)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

const Tile = memo(function Tile({
  photo,
  size,
  checked,
  onToggle,
  onPlay,
}: {
  photo: Photo;
  size: number;
  checked: boolean;
  onToggle(shift: boolean): void;
  onPlay(): void;
}) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let alive = true;
    void thumbUrl(photo.id).then((u) => alive && setSrc(u));
    return () => {
      alive = false;
    };
  }, [photo.id]);

  const label = photo.name || 'Photo';
  return (
    <div className={`tile${checked ? ' is-selected' : ''}`} role="listitem" style={{ width: size, height: size }}>
      <label className="tile-select" title={label}>
        <input
          type="checkbox"
          className="visually-hidden"
          checked={checked}
          onChange={() => undefined}
          onClick={(e) => onToggle(e.shiftKey)}
          aria-label={`Select ${label}`}
        />
        {src ? (
          <img src={src} alt={label} width={photo.width} height={photo.height} loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="tile-placeholder" aria-hidden="true" />
        )}
        <span className="tile-check" aria-hidden="true" />
      </label>
      <button type="button" className="tile-play" onClick={onPlay} aria-label={`Play slideshow from ${label}`} title="Play from here">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 5v14l11-7z" />
        </svg>
      </button>
    </div>
  );
});
