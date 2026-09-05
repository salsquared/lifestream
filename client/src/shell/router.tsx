import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';

/**
 * P0.7.2 — the four view routes, all mounted inside the AppShell frame.
 *
 * ## The views are code-split; the shell is not
 *
 * Importing all four eagerly put three.js, drei and postprocessing into the entry chunk,
 * so landing on /v/map downloaded the Corridor's whole renderer to draw a flat map:
 * measured at 1,465.84 kB raw / 424.43 kB gzip in one chunk, past Vite's 500 kB warning,
 * and P13 adds `@xyflow/react` + `d3-hierarchy` on top of it. Each route element is
 * therefore a `lazy()` boundary and Vite splits it into its own chunk.
 *
 * `AppShell` stays a static import on purpose. It is the frame every route renders inside
 * and it owns the per-save load (P4.1); making the chrome itself lazy would delay the
 * fetch behind a chunk request and buy nothing, since the shell is on screen for every
 * route anyway. The `<Suspense>` these boundaries need is in `AppShell`, wrapped around
 * the `<Outlet/>` and NOT around `<Routes>` here — see that file for why the difference
 * is load-bearing rather than cosmetic.
 *
 * The views export named components rather than defaults, so each import is mapped to the
 * `{ default }` shape `lazy` requires. Adding a default export to each view instead would
 * give every one of them two names for the same component, and a barrel that re-exported
 * the wrong one would still typecheck.
 */

const MapView = lazy(() => import('../views/map/MapView').then((m) => ({ default: m.MapView })));
const TimelineView = lazy(() =>
  import('../views/timeline/TimelineView').then((m) => ({ default: m.TimelineView })),
);
const TechTreeView = lazy(() =>
  import('../views/tech-tree/TechTreeView').then((m) => ({ default: m.TechTreeView })),
);
const FamilyTreesView = lazy(() =>
  import('../views/family-trees/FamilyTreesView').then((m) => ({ default: m.FamilyTreesView })),
);

/**
 * P4.8: the default redirect (and the unmatched-path fallback below) points at
 * /v/timeline. P0.7.2 pointed it at /v/map only because the Time Corridor rendered nothing
 * until P4 and landing there would have opened the app on an empty canvas. The Corridor
 * draws now, so the Corridor is what the app opens on — this constant is the one place
 * that decides it, which is why there is a constant and not two string literals.
 */
const DEFAULT_VIEW = '/v/timeline';

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to={DEFAULT_VIEW} replace />} />
          <Route path="/v/map" element={<MapView />} />
          <Route path="/v/timeline" element={<TimelineView />} />
          <Route path="/v/tech" element={<TechTreeView />} />
          <Route path="/v/family" element={<FamilyTreesView />} />
          <Route path="*" element={<Navigate to={DEFAULT_VIEW} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
