import { NavLink, Outlet } from 'react-router-dom';
import { HealthBadge } from './HealthBadge';
import { useSaveLoad } from './useSaveLoad';

/**
 * P0.7.1 — the app frame. A top bar (brand · view tabs · status/actions) over the mounted
 * view, which React Router renders into the <Outlet/>.
 *
 * P4.1 gave the shell the one thing it owns beyond chrome: the per-save load. `useSaveLoad`
 * fetches the world and the registry once per save and hydrates `useWorld` / `useRegistry`,
 * which is what architecture §4.2 means by "the shell owns the fetch" — no view issues its
 * own per-save query, so four views never race to load the same event list. It is mounted
 * HERE, on the frame every route renders inside, so the load survives view switches; a
 * per-view mount would refetch the world every time a tab is clicked.
 *
 * The save picker and command palette are still inert, and the URL sync that serializes
 * save + primary + filters into search params (§4.3) lands with the Corridor's filter work
 * in P9.5.
 */

const TABS = [
  { to: '/v/map', label: 'Map' },
  { to: '/v/timeline', label: 'Time Corridor' },
  { to: '/v/tech', label: 'Tech Tree' },
  { to: '/v/family', label: 'Family Trees' },
] as const;

function tabClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'shell__tab shell__tab--active' : 'shell__tab';
}

export function AppShell() {
  useSaveLoad();

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__brand">LIFEstream</span>

        <nav className="shell__tabs">
          {TABS.map((tab) => (
            <NavLink key={tab.to} to={tab.to} className={tabClass}>
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <span className="shell__spacer" />

        <div className="shell__actions">
          <HealthBadge />
          {/* Both are deliberately inert at P0, and they arrive far apart: the save picker
              is wired in P6 (Saves UI & the fork) once there is more than one save, the
              Cmd-K command palette not until P16.3 (Polish). */}
          <button type="button" className="shell__button" disabled>
            Save: —
          </button>
          <button type="button" className="shell__button" disabled>
            ⌘K
          </button>
        </div>
      </header>

      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
