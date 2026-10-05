import { useEffect, useState, useSyncExternalStore } from 'react';
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
