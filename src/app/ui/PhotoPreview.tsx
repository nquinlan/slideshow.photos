import { useEffect, useRef, useState } from 'react';
import type { Photo } from '../db/db';
import { getDisplay } from '../db/repo';
import { thumbUrl } from './thumbs';

/**
 * Larger preview of one library photo, in a modal dialog. Shows the stored
 * slideshow copy (the thumbnail stands in while it loads), keeps the photo's
 * selection checkbox, steps through the collection with ←/→ or the buttons,
 * can remove just this photo from the collection, and can start the
 * slideshow from it.
 */
export function PhotoPreview({
  photos,
  index,
  selected,
  onToggle,
  onNavigate,
  onPlayFrom,
  onRemove,
  onClose,
}: {
  photos: Photo[];
  index: number;
  selected: boolean;
  onToggle(): void;
  onNavigate(index: number): void;
  onPlayFrom(): void;
  onRemove(): void;
  onClose(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const photo = photos[index];
  const label = photo.name || 'Photo';
  const [thumb, setThumb] = useState<string>();
  const [full, setFull] = useState<{ id: string; url: string }>();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let alive = true;
    let url: string | undefined;
    setThumb(undefined);
    void thumbUrl(photo.id).then((u) => alive && setThumb(u));
    void getDisplay(photo.id).then((b) => {
      if (!b || !alive) return;
      url = URL.createObjectURL(b);
      setFull({ id: photo.id, url });
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [photo.id]);

  const go = (i: number) => i >= 0 && i < photos.length && onNavigate(i);
  const src = full?.id === photo.id ? full.url : thumb;

  return (
    <dialog
      ref={ref}
      className="dialog preview"
      aria-label={`Preview of ${label}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
        if (e.key === 'ArrowLeft') go(index - 1);
        else if (e.key === 'ArrowRight') go(index + 1);
        else return;
        e.preventDefault();
      }}
      data-testid="photo-preview"
    >
      <div className="preview-head">
        <span className="preview-title" title={label}>
          {label}
        </span>
        <span className="muted">
          {(index + 1).toLocaleString()} of {photos.length.toLocaleString()}
        </span>
        <span className="spacer" />
        <button type="button" className="btn ghost small danger" onClick={onRemove}>
          Remove from collection
        </button>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="preview-stage">
        {src ? (
          <img src={src} alt={label} width={photo.width} height={photo.height} draggable={false} />
        ) : (
          <span className="tile-placeholder" aria-hidden="true" />
        )}
      </div>
      <div className="preview-actions">
        <button type="button" className="btn ghost" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Previous photo">
          ← Previous
        </button>
        <label className={`btn preview-select${selected ? ' is-selected' : ''}`}>
          <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${label}`} />
          {selected ? 'Selected' : 'Select'}
        </label>
        <button type="button" className="btn ghost" onClick={onPlayFrom}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
          Play from here
        </button>
        <button
          type="button"
          className="btn ghost"
          onClick={() => go(index + 1)}
          disabled={index === photos.length - 1}
          aria-label="Next photo"
        >
          Next →
        </button>
      </div>
    </dialog>
  );
}
