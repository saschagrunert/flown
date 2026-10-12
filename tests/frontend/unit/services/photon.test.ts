/**
 * The client of Photon (services/photon.ts): what it sends, which must be
 * the text typed and nothing else the page knows, how it reads the answer,
 * and that it asks for the same text only once. Every request goes to a
 * stand-in for fetch; none reaches Photon.
 */
import { describe, it, expect, vi } from "vitest";
import {
  parsePlaces,
  PhotonClient,
  photonUrl,
  PHOTON_URL,
  PLACE_RESULTS,
  placeKey,
} from "../../../../flown/frontend/services/photon";

/** A feature of Photon's answer at a point, with these properties */
function feature(
  properties: Record<string, unknown>,
  coordinates: unknown = [9.18, 48.78],
): object {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties,
  };
}

/** A fetch that answers every request with `body` */
function answering(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

const STUTTGART = feature({
  name: "Stuttgart",
  type: "city",
  osm_value: "city",
  state: "Baden-Württemberg",
  country: "Germany",
  extent: [9.03, 48.87, 9.32, 48.69],
});

describe("photonUrl", () => {
  it("asks for the text alone, a few places and English names", () => {
    const url = new URL(photonUrl("Stuttgart Mitte"));

    expect(`${url.origin}${url.pathname}`).toBe(PHOTON_URL);
    expect([...url.searchParams.keys()].sort()).toEqual(["lang", "limit", "q"]);
    expect(url.searchParams.get("q")).toBe("Stuttgart Mitte");
    expect(url.searchParams.get("limit")).toBe(String(PLACE_RESULTS));
    expect(url.searchParams.get("lang")).toBe("en");
  });
});

describe("placeKey", () => {
  it("is the same for texts that differ in case and spaces alone", () => {
    expect(placeKey("  Stuttgart   Mitte ")).toBe(placeKey("stuttgart mitte"));
  });
});

describe("parsePlaces", () => {
  it("reads a place with its kind, region and extent", () => {
    expect(parsePlaces({ features: [STUTTGART] })).toEqual([
      {
        name: "Stuttgart",
        detail: "City · Baden-Württemberg, Germany",
        lng: 9.18,
        lat: 48.78,
        bounds: [
          [9.03, 48.69],
          [9.32, 48.87],
        ],
        zoom: 11,
      },
    ]);
  });

  it("names a house without a name by its street and number", () => {
    const [house] = parsePlaces({
      features: [
        feature({
          type: "house",
          osm_value: "yes",
          street: "Königstraße",
          housenumber: "1",
          city: "Stuttgart",
          country: "Germany",
        }),
      ],
    });

    expect(house).toMatchObject({
      name: "Königstraße 1",
      detail: "House · Stuttgart, Germany",
      zoom: 16,
    });
    expect(house).not.toHaveProperty("bounds");
  });

  it("writes a kind of OpenStreetMap as words", () => {
    const [stop] = parsePlaces({
      features: [feature({ name: "Hauptbahnhof", osm_value: "bus_stop" })],
    });

    expect(stop).toMatchObject({ detail: "Bus stop", zoom: 13 });
  });

  it("zooms by its own kinds of place only, not by what every object has", () => {
    const places = parsePlaces({
      features: ["city", "constructor", "toString", "__proto__"].map((type) =>
        feature({ name: "Somewhere", type }),
      ),
    });

    expect(places.map((place) => place.zoom)).toEqual([11, 13, 13, 13]);
  });

  it("leaves out a part of the region that repeats the name or another part", () => {
    const [city] = parsePlaces({
      features: [
        feature({
          name: "Berlin",
          type: "city",
          city: "Berlin",
          state: "Berlin",
          country: "Germany",
        }),
      ],
    });

    expect(city!.detail).toBe("City · Germany");
  });

  it("skips what has no point or no name", () => {
    expect(
      parsePlaces({
        features: [
          feature({ name: "No point" }, null),
          feature({ name: "Half a point" }, [9]),
          feature({ name: "Off the earth" }, [9, 91]),
          feature({ name: "Round the earth" }, [181, 48]),
          feature({ name: "Not numbers" }, ["9", "48"]),
          feature({ type: "street" }),
          null,
          "a string",
          { properties: { name: "No geometry" } },
          { geometry: { coordinates: [9, 48] } },
        ],
      }),
    ).toEqual([]);
  });

  it("takes an extent across the antimeridian on past 180", () => {
    // Fiji: from 177 degrees east to 178 degrees west
    const [place] = parsePlaces({
      features: [feature({ name: "Fiji", extent: [177, -12.5, -178, -21] })],
    });

    expect(place!.bounds).toEqual([
      [177, -21],
      [182, -12.5],
    ]);
  });

  it("ignores an extent that is not four numbers on the earth", () => {
    for (const extent of [
      [9, 48, 10],
      [9, "48", 10, 47],
      [9, 95, 10, 47],
      [9, 48, 190, 47],
      [-540, 48, 10, 47],
      7,
    ]) {
      const [place] = parsePlaces({
        features: [feature({ name: "Somewhere", extent })],
      });
      expect(place).not.toHaveProperty("bounds");
    }
  });

  it("finds nothing in an answer of another shape", () => {
    expect(parsePlaces(null)).toEqual([]);
    expect(parsePlaces("Bad gateway")).toEqual([]);
    expect(parsePlaces({ features: "none" })).toEqual([]);
  });
});

describe("PhotonClient", () => {
  it("sends no cookie and no address of the page", async () => {
    const fetcher = answering({ features: [STUTTGART] });
    const signal = new AbortController().signal;

    await new PhotonClient(fetcher).search("Stuttgart", signal);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get("q")).toBe("stuttgart");
    expect(init).toEqual({
      signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("asks once for the same text, and answers it from what it kept", async () => {
    const fetcher = answering({ features: [STUTTGART] });
    const client = new PhotonClient(fetcher);
    expect(client.cached("Stuttgart")).toBeUndefined();

    const first = await client.search("Stuttgart");
    const second = await client.search(" stuttgart ");

    expect(second).toBe(first);
    expect(client.cached("STUTTGART")).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps a bounded number of answers, forgetting the oldest", async () => {
    const fetcher = answering({ features: [] });
    const client = new PhotonClient(fetcher);

    for (let i = 0; i <= 50; i++) await client.search(`place ${i}`);

    expect(client.cached("place 0")).toBeUndefined();
    expect(client.cached("place 1")).toEqual([]);
    expect(client.cached("place 50")).toEqual([]);
  });

  it("rejects an answer that is not a success, and keeps nothing of it", async () => {
    const fetcher = answering({ message: "Too many requests" }, 429);
    const client = new PhotonClient(fetcher);

    await expect(client.search("Stuttgart")).rejects.toThrow("429");
    expect(client.cached("Stuttgart")).toBeUndefined();
  });

  it("passes on the abort of a request", async () => {
    const aborted = new DOMException("aborted", "AbortError");
    const client = new PhotonClient(() => Promise.reject(aborted));

    await expect(client.search("Stuttgart")).rejects.toBe(aborted);
  });

  it("asks the browser's fetch when given none", async () => {
    const fetcher = answering({ features: [] });
    vi.stubGlobal("fetch", fetcher);

    await expect(new PhotonClient().search("Stuttgart")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
