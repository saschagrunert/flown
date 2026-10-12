/**
 * The geocoder the search of places asks for any place on earth: Photon of
 * komoot (https://photon.komoot.io), over the data of OpenStreetMap. It
 * needs no key, and asks in return that its free service is used fairly: no
 * request for every keystroke, and no request it has answered before. So
 * the search (ui/locationSearch.ts) asks only after a pause in the typing
 * or on Enter, and from a few characters on (PLACE_MIN_LENGTH), drops a
 * request the next one replaces, and this client keeps the answers to the
 * last CACHE_SIZE texts for as long as the page is open, so none of them is
 * asked twice.
 *
 * What it sends is the text the visitor typed, and nothing else the page
 * knows: no position of the map to rank by, no cookie (`credentials:
 * "omit"`) and no address of the page (`referrerPolicy: "no-referrer"`).
 * The browser still says which site asks (the Origin of a cross-origin
 * request), and Photon sees the visitor's address, as every server does
 * (see doc/privacy.md).
 */

/** Where Photon answers; CSP connect-src names its host */
export const PHOTON_URL = "https://photon.komoot.io/api/";

/** How many places one request asks for */
export const PLACE_RESULTS = 5;

/** The fewest characters a search asks Photon for */
export const PLACE_MIN_LENGTH = 3;

/**
 * The pause in the typing after which the search asks Photon (ms). Here,
 * with no imports, so the e2e suite can read it too.
 */
export const PLACE_DEBOUNCE_MS = 600;

/** How many answers the client keeps; the oldest goes first */
const CACHE_SIZE = 50;

/**
 * The zoom a place is shown at when Photon gives no extent for it, by its
 * kind (Photon's `type`). Map units.
 */
const ZOOM_BY_TYPE: Readonly<Record<string, number>> = {
  country: 5,
  state: 7,
  county: 9,
  city: 11,
  district: 13,
  locality: 13,
  street: 15,
  house: 16,
};

/** The zoom of a place of any other kind */
const DEFAULT_PLACE_ZOOM = 13;

/** A place Photon found, as the search lists and shows it */
export interface Place {
  name: string;
  /** What kind of place and where: "Town · Bavaria, Germany" */
  detail: string;
  lng: number;
  lat: number;
  /** Its extent, `[[west, south], [east, north]]`, when Photon gives one */
  bounds?: [[number, number], [number, number]];
  /** The zoom to show it at without an extent */
  zoom: number;
}

/** The address of the request for `query`: the text, the count, English */
export function photonUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    limit: String(PLACE_RESULTS),
    lang: "en",
  });
  return `${PHOTON_URL}?${params.toString()}`;
}

/** A property of a feature as text, or "" when it is none */
function text(properties: Record<string, unknown>, key: string): string {
  const value = properties[key];
  return typeof value === "string" ? value.trim() : "";
}

/** "aerodrome" as "Aerodrome", "bus_stop" as "Bus stop" */
function kindLabel(kind: string): string {
  const words = kind.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Whether a value is a finite number */
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Whether a longitude and a latitude are a point on the earth */
function onEarth(lng: number, lat: number): boolean {
  return Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

/**
 * Photon's extent, `[west, north, east, south]` as it writes it, as bounds;
 * undefined for one that is missing or not four numbers on the earth. An
 * extent across the antimeridian (Fiji, New Zealand with its islands,
 * Russia) has its east short of its west: it goes on past 180 instead, as
 * MapLibre fits it, rather than round the other side of the world.
 */
function boundsOf(extent: unknown): Place["bounds"] {
  if (!Array.isArray(extent) || extent.length !== 4) return undefined;
  if (!extent.every(isNumber)) return undefined;
  const [west, lat1, east, lat2] = extent as [number, number, number, number];
  if (!onEarth(west, lat1) || !onEarth(east, lat2)) return undefined;
  return [
    [west, Math.min(lat1, lat2)],
    [east < west ? east + 360 : east, Math.max(lat1, lat2)],
  ];
}

/**
 * One feature of Photon's answer as a place, or null for one without a
 * point or a name. A house without a name of its own is named by its
 * street and number.
 */
function placeOf(feature: unknown): Place | null {
  if (typeof feature !== "object" || feature === null) return null;
  const { geometry, properties } = feature as {
    geometry?: { coordinates?: unknown };
    properties?: unknown;
  };
  const coordinates = geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [lng, lat] = coordinates as unknown[];
  if (!isNumber(lng) || !isNumber(lat) || !onEarth(lng, lat)) return null;
  const props =
    typeof properties === "object" && properties !== null
      ? (properties as Record<string, unknown>)
      : {};

  const street = [text(props, "street"), text(props, "housenumber")]
    .filter(Boolean)
    .join(" ");
  const name = text(props, "name") || street;
  if (!name) return null;

  const type = text(props, "type");
  const kind = text(props, "osm_value");
  // "yes" is what OpenStreetMap says of a building of no particular kind
  const label = kind && kind !== "yes" ? kindLabel(kind) : kindLabel(type);
  const region = [
    text(props, "city"),
    text(props, "state"),
    text(props, "country"),
  ].filter((part, index, parts) => {
    return part && part !== name && parts.indexOf(part) === index;
  });
  const detail = [label, region.join(", ")].filter(Boolean).join(" · ");

  const bounds = boundsOf(props["extent"]);
  return {
    name,
    detail,
    lng,
    lat,
    ...(bounds ? { bounds } : {}),
    // Its own kinds only: a `type` such as "constructor" is inherited
    zoom: Object.hasOwn(ZOOM_BY_TYPE, type)
      ? ZOOM_BY_TYPE[type]!
      : DEFAULT_PLACE_ZOOM,
  };
}

/**
 * The places of Photon's answer, a GeoJSON FeatureCollection, in its
 * order; none for an answer of another shape
 */
export function parsePlaces(body: unknown): Place[] {
  const features =
    typeof body === "object" && body !== null
      ? (body as { features?: unknown }).features
      : undefined;
  if (!Array.isArray(features)) return [];
  const places: Place[] = [];
  for (const feature of features) {
    const place = placeOf(feature);
    if (place) places.push(place);
  }
  return places;
}

/** The text a search is kept under: two searches that differ in case or
 * spaces alone are the same one */
export function placeKey(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Asks Photon for places and keeps the last CACHE_SIZE answers. `fetcher`
 * is the browser's fetch, or what a test answers with.
 */
export class PhotonClient {
  private readonly answers = new Map<string, Place[]>();

  constructor(
    private readonly fetcher: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}

  /** The places found for a text before, or undefined if never asked */
  cached(query: string): Place[] | undefined {
    return this.answers.get(placeKey(query));
  }

  /**
   * The places for a text, from what was kept or from Photon. Rejects with
   * the AbortError of `signal` once it aborts, and with an error for an
   * answer that is not a success.
   */
  async search(query: string, signal?: AbortSignal): Promise<Place[]> {
    const key = placeKey(query);
    const kept = this.answers.get(key);
    if (kept) return kept;
    const response = await this.fetcher(photonUrl(key), {
      ...(signal ? { signal } : {}),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new Error(`Photon answered ${response.status}`);
    const places = parsePlaces(await response.json());
    if (this.answers.size >= CACHE_SIZE) {
      this.answers.delete(this.answers.keys().next().value!);
    }
    this.answers.set(key, places);
    return places;
  }
}
