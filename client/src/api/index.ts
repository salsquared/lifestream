/**
 * The client's API layer (P1.12.3, P2.6) — every call to the LIFEstream API goes through
 * here. One deliberate exception: `views/map/renderer/features.ts` fetches the vendored
 * topojson directly, because that is a static asset from the app's own origin rather than
 * an API read, and the renderer is presentational and does not import this layer.
 *
 * Two levels. `./client` is the transport: it appends `?save=` for a per-save read (P1.13)
 * or write, insists on a JSON body, and turns every failure into an `ApiError`. `./map`
 * and its successors are the endpoints: one function per URL in architecture §5.1/§5.2,
 * each returning the shared entity types from `@shared/types` with no renaming anywhere —
 * camelCase from the column definition to the component prop (the wire-format decision).
 *
 * Import from here, not from the modules underneath: what an endpoint's URL is, and how
 * the save gets onto it, are this directory's business.
 */

export { ApiError, getForSave, getGlobal, sendForSave } from './client';
export type { RequestOptions, WriteMethod } from './client';

export {
  assignCountryToGrouping,
  clearCountryOverride,
  createGrouping,
  deleteGrouping,
  fetchMapCountries,
  fetchMapGroupings,
  GroupingConflictError,
  MembershipConflictError,
  removeCountryFromGrouping,
  replaceGroupingCountries,
  setCountryOverride,
  updateGrouping,
} from './map';
export type { GroupingDraft, GroupingPatch, MapGroupings } from './map';
