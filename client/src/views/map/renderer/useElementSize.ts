/**
 * Measure the element the map fills.
 *
 * `WorldMapProps` (the P2 contract) carries no width or height, and rightly: the size is a
 * fact about the DOM, not about the world being drawn. So the renderer measures its own
 * host and projects into that.
 *
 * {@link FALLBACK_SIZE} is what the first render — and any environment with no
 * `ResizeObserver`, such as a server render — draws at. It is a real size rather than zero
 * on purpose: `fitExtent` into a zero-sized box produces a degenerate projection, and a
 * first paint of nothing followed by a resize is a visible flash.
 */

import { useEffect, useState } from 'react';

import type { RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/** 16:9, the shape of a maximised view pane. Replaced by the real size on the first measure. */
export const FALLBACK_SIZE: ElementSize = { width: 960, height: 540 };

export function useElementSize(ref: RefObject<Element | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>(FALLBACK_SIZE);

  useEffect(() => {
    const node = ref.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;

    const measure = (): void => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width <= 0 || height <= 0) return;
      // Compared before setting: a ResizeObserver fires on every layout pass, and an
      // unconditional setState here would re-seed the input mode (whose key is the size)
      // on each one.
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [ref]);

  return size;
}
