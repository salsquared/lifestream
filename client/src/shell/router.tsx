import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { FamilyTreesView } from '../views/family-trees/FamilyTreesView';
import { MapView } from '../views/map/MapView';
import { TechTreeView } from '../views/tech-tree/TechTreeView';
import { TimelineView } from '../views/timeline/TimelineView';

/**
 * P0.7.2 — the four view routes, all mounted inside the AppShell frame.
 *
 * P4.8: the default redirect (and the unmatched-path fallback below) now points at
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
