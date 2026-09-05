/**
 * The four registry reads (P3.6.4) — architecture §5.2, §2.2.
 *
 * FOUR URLS, NOT ONE: `/api/characters`, `/api/locations`, `/api/projects`,
 * `/api/character-relations`. There is no `/api/registry` prefix and there never was — the
 * server's nine route modules are a file layout, not a URL layout (§4.4), and `registry.ts`
 * over there owns four prefixes. `useRegistry` (§4.2) fans these in; the name is a STORE,
 * not a URL.
 *
 * Entity types come from `@shared/types/index` and are never redeclared.
 */
import type { Character, CharacterRelation, Location, Project } from '@shared/types/index';

import { getForSave, type RequestOptions } from './client';
import { arrayField, objectField, segment } from './envelope';

const CHARACTERS_URL = '/api/characters';
const LOCATIONS_URL = '/api/locations';
const PROJECTS_URL = '/api/projects';
const CHARACTER_RELATIONS_URL = '/api/character-relations';

/** `GET /api/characters` — the save's cast, ordered by name. */
export async function fetchCharacters(
  saveId: string,
  options?: RequestOptions,
): Promise<Character[]> {
  const body = await getForSave(CHARACTERS_URL, saveId, options);
  return arrayField<Character>(body, 'characters', CHARACTERS_URL);
}

/** `GET /api/characters/:id` — one character. 404s if the id is not in this save. */
export async function fetchCharacter(
  saveId: string,
  characterId: string,
  options?: RequestOptions,
): Promise<Character> {
  const url = `${CHARACTERS_URL}/${segment(characterId)}`;
  const body = await getForSave(url, saveId, options);
  return objectField<Character>(body, 'character', url);
}

/**
 * `GET /api/locations` — every place in the save, ordered by name.
 *
 * EVERY STAGE OF A RENAME CHAIN IS ITS OWN ROW AND ALL OF THEM ARRIVE. "COP Isotope",
 * "FOB Oasis", "Camp Oasis", "Oasis City" and "Star City" are five rows linked by
 * `supersededByLocationId` (§2.2), because an event sited at "FOB Oasis" has to render
 * under the name the place had at the time. Walk the chain when a view needs the canonical
 * head; the server does not collapse it.
 */
export async function fetchLocations(
  saveId: string,
  options?: RequestOptions,
): Promise<Location[]> {
  const body = await getForSave(LOCATIONS_URL, saveId, options);
  return arrayField<Location>(body, 'locations', LOCATIONS_URL);
}

/** `GET /api/locations/:id` — one place. 404s if the id is not in this save. */
export async function fetchLocation(
  saveId: string,
  locationId: string,
  options?: RequestOptions,
): Promise<Location> {
  const url = `${LOCATIONS_URL}/${segment(locationId)}`;
  const body = await getForSave(url, saveId, options);
  return objectField<Location>(body, 'location', url);
}

/**
 * `GET /api/projects` — the save's programmes, ordered by name.
 *
 * `dateStart` / `dateEnd` arrive with their PRECISION columns and are never formatted
 * (§2.3): "Expected 2086" is year precision, and the instant beside it is a January-1
 * placeholder no view may print.
 */
export async function fetchProjects(saveId: string, options?: RequestOptions): Promise<Project[]> {
  const body = await getForSave(PROJECTS_URL, saveId, options);
  return arrayField<Project>(body, 'projects', PROJECTS_URL);
}

/** `GET /api/projects/:id` — one programme. 404s if the id is not in this save. */
export async function fetchProject(
  saveId: string,
  projectId: string,
  options?: RequestOptions,
): Promise<Project> {
  const url = `${PROJECTS_URL}/${segment(projectId)}`;
  const body = await getForSave(url, saveId, options);
  return objectField<Project>(body, 'project', url);
}

/**
 * `GET /api/character-relations` — the family graph's STORED edges.
 *
 * Authored edges only. Two characters sharing a `parent-of` parent are siblings by
 * construction and canon's Adan–X pair is deliberately not stored (P3.2.5); Family Trees
 * derives that one (P14.5). Symmetric types (`spouse-of`, `sibling-of`) arrive once, with
 * the lower id as `fromCharacterId`, and render undirected (§2.2).
 */
export async function fetchCharacterRelations(
  saveId: string,
  options?: RequestOptions,
): Promise<CharacterRelation[]> {
  const body = await getForSave(CHARACTER_RELATIONS_URL, saveId, options);
  return arrayField<CharacterRelation>(body, 'characterRelations', CHARACTER_RELATIONS_URL);
}

/** `GET /api/character-relations/:id` — one edge. 404s if the id is not in this save. */
export async function fetchCharacterRelation(
  saveId: string,
  characterRelationId: string,
  options?: RequestOptions,
): Promise<CharacterRelation> {
  const url = `${CHARACTER_RELATIONS_URL}/${segment(characterRelationId)}`;
  const body = await getForSave(url, saveId, options);
  return objectField<CharacterRelation>(body, 'characterRelation', url);
}
