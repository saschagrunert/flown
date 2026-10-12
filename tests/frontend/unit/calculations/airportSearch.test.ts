/**
 * The site's airports as the search finds them (calculations/airportSearch.ts):
 * what answers a query at all, and the order of what does, which decides
 * what Enter takes when no option is active.
 */
import { describe, it, expect } from "vitest";
import {
  AIRPORT_RESULTS,
  foldText,
  matchAirports,
} from "../../../../flown/frontend/calculations/airportSearch";
import type { Airport } from "../../../../flown/frontend/types";

function airport(name: string, code?: string, country?: string): Airport {
  return {
    name,
    lat: 48,
    lon: 9,
    ...(code ? { code } : {}),
    ...(country ? { country } : {}),
  };
}

const STUTTGART = airport("EDDS Stuttgart", "EDDS", "DE");
const FRANKFURT = airport("EDDF Frankfurt Main", "EDDF", "DE");
const ZURICH = airport("LSZH Zürich", "LSZH", "CH");
const HOME = airport("Home strip");
const SCHWAEBISCH = airport("EDTY Schwäbisch Hall", "EDTY", "DE");
const AIRPORTS = [STUTTGART, FRANKFURT, ZURICH, HOME, SCHWAEBISCH];

const names = (found: Airport[]): string[] => found.map((a) => a.name);

describe("foldText", () => {
  it("drops case, accents and the spaces at the ends", () => {
    expect(foldText("  Zürich ")).toBe("zurich");
    expect(foldText("Schwäbisch Hall")).toBe("schwabisch hall");
  });

  it("spells out the letters that are no letter and an accent", () => {
    expect(foldText("Łódź")).toBe("lodz");
    expect(foldText("København")).toBe("kobenhavn");
    expect(foldText("Bodø")).toBe("bodo");
    expect(foldText("Tromsø")).toBe("tromso");
    expect(foldText("Ærø Straße Þingvellir")).toBe("aero strasse thingvellir");
  });

  it("lets an airport be found without those letters", () => {
    const airports = [
      { name: "Łódź", code: "EPLL", lat: 51.7, lon: 19.4 },
      { name: "København Kastrup", code: "EKCH", lat: 55.6, lon: 12.6 },
      { name: "Bodø", code: "ENBO", lat: 67.3, lon: 14.4 },
      { name: "Tromsø", code: "ENTC", lat: 69.7, lon: 18.9 },
    ];
    expect(names(matchAirports(airports, "lodz"))).toEqual(["Łódź"]);
    expect(names(matchAirports(airports, "kobenhavn"))).toEqual([
      "København Kastrup",
    ]);
    expect(names(matchAirports(airports, "bodo"))).toEqual(["Bodø"]);
    expect(names(matchAirports(airports, "tromso"))).toEqual(["Tromsø"]);
  });
});

describe("matchAirports", () => {
  it("finds nothing for nothing typed", () => {
    expect(matchAirports(AIRPORTS, "")).toEqual([]);
    expect(matchAirports(AIRPORTS, "   ")).toEqual([]);
  });

  it("finds nothing where nothing answers", () => {
    expect(matchAirports(AIRPORTS, "Paris")).toEqual([]);
  });

  it("finds an airport by its code, in any case", () => {
    expect(names(matchAirports(AIRPORTS, "edds"))).toEqual(["EDDS Stuttgart"]);
  });

  it("puts the code typed in full before a code that only starts with it", () => {
    const codes = [airport("Big field", "EDD"), STUTTGART, FRANKFURT];

    expect(names(matchAirports(codes, "EDD"))).toEqual([
      "Big field",
      // The two that only start with it, the shorter name first
      "EDDS Stuttgart",
      "EDDF Frankfurt Main",
    ]);
  });

  it("finds a name by its start, a word of it or what is inside it", () => {
    const fields = [
      airport("Hallendorf"),
      airport("Big Hall field"),
      airport("Marshall"),
    ];

    expect(names(matchAirports(fields, "hall"))).toEqual([
      "Hallendorf",
      "Big Hall field",
      "Marshall",
    ]);
  });

  it("does not mind accents", () => {
    expect(names(matchAirports(AIRPORTS, "zurich"))).toEqual(["LSZH Zürich"]);
    expect(names(matchAirports(AIRPORTS, "schwab"))).toEqual([
      "EDTY Schwäbisch Hall",
    ]);
  });

  it("finds an airport by every word typed, its country's included", () => {
    expect(names(matchAirports(AIRPORTS, "stuttgart germany"))).toEqual([
      "EDDS Stuttgart",
    ]);
    expect(names(matchAirports(AIRPORTS, "main frankfurt"))).toEqual([
      "EDDF Frankfurt Main",
    ]);
    expect(names(matchAirports(AIRPORTS, "switzerland"))).toEqual([
      "LSZH Zürich",
    ]);
  });

  it("finds an airport without a code by its name", () => {
    expect(names(matchAirports(AIRPORTS, "strip"))).toEqual(["Home strip"]);
  });

  it("lists no more than it is asked for, the best first", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      airport(`Field ${String(i).padStart(2, "0")}`),
    );

    const found = matchAirports(many, "field");
    expect(found).toHaveLength(AIRPORT_RESULTS);
    expect(names(found)[0]).toBe("Field 00");
    expect(matchAirports(many, "field", 2)).toHaveLength(2);
  });

  it("follows a new list of airports", () => {
    expect(matchAirports(AIRPORTS, "EDDS")).toHaveLength(1);
    expect(matchAirports([HOME], "EDDS")).toEqual([]);
  });
});
