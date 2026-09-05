import { useEffect, useRef } from 'react';

/**
 * The right-click menu on a country (P2.3.5) — rename for this save, or restore the
 * default name.
 *
 * WHY IT IS A MENU AND NOT STRAIGHT TO A PROMPT. The two commands are not the same write:
 * a rename PUTs a `country_override` row, and a reset DELETES it rather than storing the
 * default name in it (§7.4, and the endpoint enforces this). With only a prompt, "reset"
 * would have to be expressed as clearing the field, which is both undiscoverable and
 * ambiguous with "I changed my mind". Naming the two commands separately is what makes
 * the delete reachable at all.
 *
 * "Restore default" is offered ONLY when this save actually renames the country — that
 * is, when the name in the payload differs from the atlas default. It matters because
 * `DELETE /api/country-overrides/:countryId` answers 404 when there is no row, so
 * offering it unconditionally would produce an error message for a no-op.
 *
 * POSITIONING assumes `at` is in VIEWPORT coordinates (a pointer event's `clientX`/
 * `clientY`), which is what the pinned `onCountryContextMenu(countryId, at)` signature
 * implies and what `position: fixed` consumes directly. If the renderer ever reports
 * SVG-local coordinates instead, this is the one place that changes.
 */

export type CountryMenuProps = {
  at: { x: number; y: number };
  /** The name currently shown for the country — what the rename prompt starts from. */
  name: string;
  /** The atlas default, when the derived feature set has loaded and differs from `name`. */
  resettableTo?: string;
  onRename: () => void;
  onReset: () => void;
  onClose: () => void;
};

export function CountryMenu(props: CountryMenuProps) {
  const { onClose } = props;
  const menu = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target;
      if (target instanceof Node && menu.current?.contains(target) === true) return;
      onClose();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }

    // `pointerdown` and not `click`: the menu must be gone before the next click reaches
    // the map, or dismissing it would also select a country.
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      className="map-menu"
      style={{ left: props.at.x, top: props.at.y }}
      role="menu"
      aria-label={`Actions for ${props.name}`}
    >
      <span className="map-menu__title">{props.name}</span>
      <button type="button" className="map-menu__item" role="menuitem" onClick={props.onRename}>
        Rename in this save…
      </button>
      {props.resettableTo !== undefined && (
        <button type="button" className="map-menu__item" role="menuitem" onClick={props.onReset}>
          Restore “{props.resettableTo}”
        </button>
      )}
    </div>
  );
}
