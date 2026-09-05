import { NavLink, Outlet } from 'react-router-dom';
import { HealthBadge } from './HealthBadge';

/**
 * P0.7.1 — the app frame. A top bar (brand · view tabs · status/actions) over the mounted
 * view, which React Router renders into the <Outlet/>.
 *
 * At P0 the shell owns no state: the save picker and command palette are present but
 * disabled, and nothing here reads the zustand stores yet. The shell-owned per-save
 * registry/world fetch (architecture §4.2) is what the views start reading in P2; the
 * URL sync that serializes save + primary + filters into search params (§4.3) is not
 * P2 — it lands with the Corridor's filter work in P9.5.
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
