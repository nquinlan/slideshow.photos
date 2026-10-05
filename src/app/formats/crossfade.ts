/**
 * Crossfade: a plain opacity blend. Used automatically when the user has
 * `prefers-reduced-motion: reduce`, and selectable like any other format.
 */
import { EASINGS, animate, composeSlide, createSurface, ctx2d, sizeCanvas, stageSize, type Surface } from './shared';
import type { FormatContext, FormatInstance, RenderOptions, SlideImage, SlideshowFormat, Viewport } from './types';

class CrossfadeInstance implements FormatInstance {
  private ctx: CanvasRenderingContext2D;
  private current: Surface;
  private incoming: Surface;
  private currentImage?: SlideImage;

  constructor(private c: FormatContext) {
    this.ctx = ctx2d(c.canvas);
    const { width, height } = stageSize(c.viewport);
    sizeCanvas(c.canvas, width, height);
    this.current = createSurface(width, height);
    this.incoming = createSurface(width, height);
  }

  init(first: SlideImage) {
    this.currentImage = first;
    composeSlide(this.current, first, this.c.render);
    this.ctx.globalAlpha = 1;
    this.ctx.drawImage(this.current as CanvasImageSource, 0, 0);
  }

  async transition(next: SlideImage, durationMs: number, signal?: AbortSignal) {
    composeSlide(this.incoming, next, this.c.render);
    const ctx = this.ctx;
    await animate(
      durationMs,
      (t) => {
        const a = EASINGS['ease-in-out-sine'](t);
        ctx.globalAlpha = 1;
        ctx.drawImage(this.current as CanvasImageSource, 0, 0);
        ctx.globalAlpha = a;
        ctx.drawImage(this.incoming as CanvasImageSource, 0, 0);
        ctx.globalAlpha = 1;
      },
      signal,
    );
    [this.current, this.incoming] = [this.incoming, this.current];
    this.currentImage = next;
  }

  resize(v: Viewport) {
    this.c.viewport = v;
    const { width, height } = stageSize(v);
    sizeCanvas(this.c.canvas, width, height);
    sizeCanvas(this.current, width, height);
    sizeCanvas(this.incoming, width, height);
    if (this.currentImage) this.init(this.currentImage);
  }

  setRenderOptions(render: RenderOptions) {
    this.c.render = render;
    if (this.currentImage) this.init(this.currentImage);
  }

  destroy() {
    sizeCanvas(this.current, 1, 1);
    sizeCanvas(this.incoming, 1, 1);
    this.currentImage = undefined;
  }
}

export const crossfade: SlideshowFormat = {
  id: 'crossfade',
  name: 'Crossfade',
  description: 'A gentle fade between photos. Used automatically when your system asks for reduced motion.',
  settingsSchema: [],
  create: (ctx) => new CrossfadeInstance(ctx),
};
