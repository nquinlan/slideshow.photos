import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getStorageInfo, type StorageInfo } from '../import/storage';

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  return () => {
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = matchMedia(query);
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => matchMedia(query).matches,
    () => false,
  );
}

export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');

/**
 * Ref callback that keeps a CSS custom property on <html> equal to the
 * element's height, so sticky layout below it can follow it as it wraps.
 */
export function useHeightVar(name: string) {
  const observer = useRef<ResizeObserver>(undefined);
  return useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!el) return;
      const set = () => document.documentElement.style.setProperty(name, `${el.offsetHeight}px`);
      set();
      observer.current = new ResizeObserver(set);
      observer.current.observe(el);
    },
    [name],
  );
}

/** navigator.storage.estimate(), refreshed when `version` changes. */
export function useStorageInfo(version: unknown): StorageInfo | undefined {
  const [info, setInfo] = useState<StorageInfo>();
  useEffect(() => {
    let alive = true;
    void getStorageInfo().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [version]);
  return info;
}
