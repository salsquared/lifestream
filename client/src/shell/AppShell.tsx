import { NavLink, Outlet } from 'react-router-dom';
import { HealthBadge } from './HealthBadge';

/**
 * P0.7.1 — the app frame. A top bar (brand · view tabs · status/actions) over the mounted
 * view, which React Router renders into the <Outlet/>.
 *
 * At P0 the shell owns no state: the save picker and command palette are present but
 * disabled, and nothing here reads the zustand stores yet. From P2 on this is also where
 * URL sync and the per-save registry/world fetch live (architecture §4.1/§4.2).
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
          {/* Both are deliberately inert at P0: the save picker is wired in P6 once saves
              exist, the command palette in the shared-components phase that follows. */}
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
