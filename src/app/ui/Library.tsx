import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Photo } from '../db/db';
import { PhotoPreview } from './PhotoPreview';
import { thumbUrl } from './thumbs';

interface Props {
  photos: Photo[];
  selected: Set<string>;
  onSelectionChange(next: Set<string>): void;
  onPlayFrom(photoId: string): void;
  onRemove(photoIds: string[]): Promise<void>;
}

const MIN_TILE = 132;
const GAP = 6;

/**
 * Virtualized thumbnail grid (rows are windowed against page scroll), so a
 * 5,000-photo collection renders only the ~10 rows in view. Each tile is a
 * real checkbox for selection (keyboard + screen-reader friendly) plus an
 * expand button that opens a larger preview. Shift-click selects a range.
 */
export function Library({ photos, selected, onSelectionChange, onPlayFrom, onRemove }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [offset, setOffset] = useState(0);
  const lastClicked = useRef<number>(-1);
  const [previewId, setPreviewId] = useState<string>();
  const previewIndex = previewId ? photos.findIndex((p) => p.id === previewId) : -1;

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

  /** Close the preview, bringing the photo it ended on into view and focusing its expand button. */
  const closePreview = () => {
    const id = previewId;
    setPreviewId(undefined);
    if (previewIndex < 0) return;
    virtualizer.scrollToIndex(Math.floor(previewIndex / cols), { align: 'auto' });
    requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLButtonElement>(`[data-photo-id="${CSS.escape(id!)}"] .tile-expand`)?.focus(),
    );
  };

  return (
    <>
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
                  onExpand={() => setPreviewId(p.id)}
                />
              );
            })}
          </div>
        ))}
      </div>
      {previewIndex >= 0 && (
        <PhotoPreview
          photos={photos}
          index={previewIndex}
          selected={selected.has(photos[previewIndex].id)}
          onToggle={() => toggle(previewIndex, false)}
          onNavigate={(i) => setPreviewId(photos[i].id)}
          onPlayFrom={() => {
            setPreviewId(undefined);
            onPlayFrom(photos[previewIndex].id);
          }}
          onRemove={() => {
            // Move on to the next photo (or the previous one at the end); close when none are left.
            const id = photos[previewIndex].id;
            setPreviewId((photos[previewIndex + 1] ?? photos[previewIndex - 1])?.id);
            void onRemove([id]);
          }}
          onClose={closePreview}
        />
      )}
    </>
  );
}

const Tile = memo(function Tile({
  photo,
  size,
  checked,
  onToggle,
  onExpand,
}: {
  photo: Photo;
  size: number;
  checked: boolean;
  onToggle(shift: boolean): void;
  onExpand(): void;
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
    <div
      className={`tile${checked ? ' is-selected' : ''}`}
      role="listitem"
      style={{ width: size, height: size }}
      data-photo-id={photo.id}
    >
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
      <button type="button" className="tile-expand" onClick={onExpand} aria-label={`Preview ${label}`} title="Preview larger">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z" />
        </svg>
      </button>
    </div>
  );
});
