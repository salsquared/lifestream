import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { FamilyTreesView } from '../views/family-trees/FamilyTreesView';
import { MapView } from '../views/map/MapView';
import { TechTreeView } from '../views/tech-tree/TechTreeView';
import { TimelineView } from '../views/timeline/TimelineView';

/**
 * P0.7.2 — the four view routes, all mounted inside the AppShell frame.
 *
 * The default redirect points at /v/map, NOT /v/timeline: the Time Corridor renders
 * nothing until P4, so landing there would open the app on an empty canvas. P4.8 flips
 * this redirect (and the unmatched-path fallback below) to /v/timeline once the Corridor
 * actually draws.
 */
const DEFAULT_VIEW = '/v/map';

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
