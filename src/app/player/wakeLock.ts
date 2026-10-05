/**
 * Screen Wake Lock for the duration of playback. The browser drops the lock
 * whenever the page is hidden, so we re-acquire it when it becomes visible.
 */
export class WakeLockGuard {
  private sentinel: WakeLockSentinel | null = null;
  private active = false;

  private onVisibility = () => {
    if (this.active && document.visibilityState === 'visible' && !this.sentinel) void this.acquire();
  };

  get supported() {
    return 'wakeLock' in navigator;
  }

  async start() {
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    await this.acquire();
  }

  async stop() {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch {
      /* already released */
    }
  }

  private async acquire() {
    if (!this.supported) return;
    try {
      const s = await navigator.wakeLock.request('screen');
      if (!this.active) return void s.release();
      this.sentinel = s;
      s.addEventListener('release', () => {
        if (this.sentinel === s) this.sentinel = null;
      });
    } catch {
      // NotAllowedError: page hidden, battery saver, or permissions policy.
    }
  }
}
