import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Metadata, PathInfo } from "../../../../flown/frontend/types";
import type { SiteData } from "../../../../flown/frontend/state/siteData";
import { filterPaths } from "../../../../flown/frontend/calculations/statistics";

type AirportsModule =
  typeof import("../../../../flown/frontend/features/airports");
type CountriesModule =
  typeof import("../../../../flown/frontend/features/countries");

describe("airports feature", () => {
  let mod: AirportsModule;
  let countries: CountriesModule;
  /** The site data of the module instance under test */
  let siteData: SiteData;

  beforeEach(async () => {
    vi.resetModules();
    mod = await import("../../../../flown/frontend/features/airports");
    countries = await import("../../../../flown/frontend/features/countries");
    ({ siteData } = await import("../../../../flown/frontend/state/siteData"));
  });

  const mockPathInfo: PathInfo[] = [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      start_airport: "EDAV",
      end_airport: "EDDF",
    },
    {
      id: 2,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      start_airport: "EDDF",
      end_airport: "EDAV",
    },
    {
      id: 3,
      year: 2024,
      aircraft_registration: "D-EXYZ",
      start_airport: "EDDM",
      end_airport: "EDDK",
    },
    {
      id: 4,
      year: 2025,
      aircraft_registration: "D-EXYZ",
      start_airport: "EDAV",
      end_airport: "EDAV",
    },
  ];

  describe("calculateAirportFlightCounts", () => {
    it("counts flights to all airports with no filters", () => {
      expect(
        mod.calculateAirportFlightCounts(
          filterPaths(mockPathInfo, "all", "all"),
        ),
      ).toEqual({ EDAV: 3, EDDF: 2, EDDM: 1, EDDK: 1 });
    });

    it("filters by year", () => {
      expect(
        mod.calculateAirportFlightCounts(
          filterPaths(mockPathInfo, "2025", "all"),
        ),
      ).toEqual({ EDAV: 3, EDDF: 2 });
    });

    it("filters by aircraft", () => {
      expect(
        mod.calculateAirportFlightCounts(
          filterPaths(mockPathInfo, "all", "D-EAGJ"),
        ),
      ).toEqual({ EDAV: 2, EDDF: 2 });
    });

    it("filters by both year and aircraft", () => {
      expect(
        mod.calculateAirportFlightCounts(
          filterPaths(mockPathInfo, "2025", "D-EXYZ"),
        ),
      ).toEqual({ EDAV: 1 });
    });

    it("counts round trips only once per airport", () => {
      expect(
        mod.calculateAirportFlightCounts([
          { id: 1, start_airport: "EDAV", end_airport: "EDAV" },
        ]),
      ).toEqual({ EDAV: 1 });
    });

    it("counts an airport that names an object property (regression)", () => {
      const counts = mod.calculateAirportFlightCounts([
        { id: 1, start_airport: "constructor", end_airport: "__proto__" },
        { id: 2, start_airport: "constructor" },
      ]);
      expect(counts["constructor"]).toBe(2);
      expect(counts["__proto__"]).toBe(1);
      expect(Object.keys(counts).sort()).toEqual(["__proto__", "constructor"]);
      expect(mod.findHomeBase(counts)).toBe("constructor");
    });

    it("handles paths without airports", () => {
      expect(
        mod.calculateAirportFlightCounts([
          { id: 1, year: 2025 },
          { id: 2, year: 2025, start_airport: "EDAV" },
        ]),
      ).toEqual({ EDAV: 1 });
    });

    it("returns empty object when no paths match filters", () => {
      expect(
        mod.calculateAirportFlightCounts(
          filterPaths(mockPathInfo, "2023", "all"),
        ),
      ).toEqual({});
    });
  });

  describe("findHomeBase", () => {
    it("finds airport with most flights", () => {
      expect(mod.findHomeBase({ EDAV: 10, EDDF: 5, EDDM: 3 })).toBe("EDAV");
    });

    it("returns null for empty counts", () => {
      expect(mod.findHomeBase({})).toBeNull();
    });

    it("returns the first airport when counts are tied", () => {
      expect(mod.findHomeBase({ EDAV: 5, EDDF: 5 })).toBe("EDAV");
    });
  });

  describe("calculateVisibleAirports", () => {
    /** The airports shown for a filter and selection of `pathInfo` */
    const visibleAirports = (options: {
      pathInfo: PathInfo[];
      selectedYear?: string;
      selectedAircraft?: string;
      selectedPathIds?: Set<number>;
      isolateSelection?: boolean;
      pathInfoById?: Map<number, PathInfo>;
    }): Set<string> | null => {
      const {
        pathInfo,
        selectedYear = "all",
        selectedAircraft = "all",
      } = options;
      return mod.calculateVisibleAirports(
        selectedYear === "all" && selectedAircraft === "all"
          ? null
          : filterPaths(pathInfo, selectedYear, selectedAircraft),
        options.selectedPathIds ?? new Set(),
        options.isolateSelection ?? false,
        options.pathInfoById ?? new Map(pathInfo.map((p) => [p.id, p])),
      );
    };

    it("returns null (all visible) without filters or selection", () => {
      expect(visibleAirports({ pathInfo: mockPathInfo })).toBeNull();
    });

    it("returns airports of paths matching the year filter", () => {
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2024",
      });
      expect([...visible!].sort()).toEqual(["EDDK", "EDDM"]);
    });

    it("returns airports of paths matching the aircraft filter", () => {
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedAircraft: "D-EAGJ",
      });
      expect([...visible!].sort()).toEqual(["EDAV", "EDDF"]);
    });

    it("adds airports of selected paths to the filtered set", () => {
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2025",
        selectedPathIds: new Set([3]),
      });
      expect([...visible!].sort()).toEqual(["EDAV", "EDDF", "EDDK", "EDDM"]);
    });

    it("only returns airports of selected paths in share mode", () => {
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2025",
        selectedPathIds: new Set([3]),
        isolateSelection: true,
      });
      expect([...visible!].sort()).toEqual(["EDDK", "EDDM"]);
    });

    it("shows no airport in share mode whose shown flights are none", () => {
      // The store ends share mode with its last flight; a filter that hides
      // every shared flight leaves nothing of them on the map
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedYear: "2024",
        isolateSelection: true,
      });
      expect([...visible!]).toEqual([]);
    });

    it("keeps every airport for a selection without a filter (regression)", () => {
      // A year filter keeps its airports beside a selection, so no filter
      // must not hide every airport the selection does not touch
      expect(
        visibleAirports({
          pathInfo: mockPathInfo,
          selectedPathIds: new Set([3]),
        }),
      ).toBeNull();
    });

    it("uses the provided path info map for selected paths", () => {
      const byId = new Map<number, PathInfo>([
        [99, { id: 99, start_airport: "LOWW" }],
      ]);
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedPathIds: new Set([99, 1]),
        isolateSelection: true,
        pathInfoById: byId,
      });
      // path 1 is unknown to the map, so only LOWW is visible
      expect([...visible!]).toEqual(["LOWW"]);
    });

    it("ignores unknown selected path ids", () => {
      const visible = visibleAirports({
        pathInfo: mockPathInfo,
        selectedPathIds: new Set([999]),
        isolateSelection: true,
      });
      expect(visible!.size).toBe(0);
    });
  });

  describe("countryFlagSrc", () => {
    it("points at the flag the site published", () => {
      siteData.metadata = { available_flags: ["de", "at"] } as Metadata;

      expect(countries.countryFlagSrc("DE")).toBe("flags/de.svg");
      expect(countries.countryFlagSrc("at")).toBe("flags/at.svg");
    });

    it("has none for a country the site did not publish", () => {
      siteData.metadata = { available_flags: ["de"] } as Metadata;

      expect(countries.countryFlagSrc("FR")).toBeNull();
    });

    it("has none at all without the list", () => {
      // A site built from a wheel, which leaves the flag files out
      siteData.metadata = {} as Metadata;

      expect(countries.countryFlagSrc("DE")).toBeNull();
    });
  });

  describe("country lookups", () => {
    beforeEach(() => {
      siteData.airports = [
        { name: "EDAV Halle-Oppin", lat: 51, lon: 12, country: "DE" },
        { name: "EDDF Frankfurt", lat: 50, lon: 8, country: "DE" },
        { name: "LSZH Zurich", lat: 47, lon: 8, country: "CH" },
        { name: "LKPR Prague", lat: 50, lon: 14, country: "CZ" },
        { name: "NOCOUNTRY", lat: 0, lon: 0 },
      ];
    });

    it("countCountries returns unique country codes for given airports", () => {
      const found = countries.countCountries([
        "EDAV Halle-Oppin",
        "EDDF Frankfurt",
        "LSZH Zurich",
      ]);
      expect([...found].sort()).toEqual(["CH", "DE"]);
    });

    it("countCountries skips unknown airports and airports without country", () => {
      expect(countries.countCountries([]).size).toBe(0);
      expect([
        ...countries.countCountries([
          "EDAV Halle-Oppin",
          "UNKNOWN",
          "NOCOUNTRY",
        ]),
      ]).toEqual(["DE"]);
    });

    it("groupByCountry groups airports by country code in first-seen order", () => {
      const grouped = countries.groupByCountry([
        "LSZH Zurich",
        "EDAV Halle-Oppin",
        "EDDF Frankfurt",
        "LKPR Prague",
      ]);
      expect([...grouped.entries()]).toEqual([
        ["CH", ["LSZH Zurich"]],
        ["DE", ["EDAV Halle-Oppin", "EDDF Frankfurt"]],
        ["CZ", ["LKPR Prague"]],
      ]);
    });

    it("groupByCountry puts unknown airports under 'Other'", () => {
      expect(
        countries.groupByCountry(["UNKNOWN Airport"]).get("Other"),
      ).toEqual(["UNKNOWN Airport"]);
      expect(countries.groupByCountry([]).size).toBe(0);
    });

    it("follows a replaced airport list", () => {
      expect(countries.countCountries(["EDAV Halle-Oppin"]).size).toBe(1);
      siteData.airports = [];
      expect(countries.countCountries(["EDAV Halle-Oppin"]).size).toBe(0);
    });

    it("keeps the map while the airport list stays the same", () => {
      const airports = siteData.airports!;
      expect(countries.groupByCountry(["LSZH Zurich"]).get("CH")).toEqual([
        "LSZH Zurich",
      ]);
      // A change inside the same array is not seen: the list is treated as
      // immutable once loaded, like the rest of the page treats it
      airports.push({ name: "LOWW Vienna", lat: 48, lon: 16, country: "AT" });
      expect(countries.countCountries(["LOWW Vienna"]).size).toBe(0);
    });

    it("handles airports that have not loaded", () => {
      siteData.airports = null;
      expect(countries.countCountries(["EDAV Halle-Oppin"]).size).toBe(0);
    });

    it("picks up airports.json when it arrives after the first lookup", () => {
      siteData.airports = null;
      expect(countries.countCountries(["EDAV Halle-Oppin"]).size).toBe(0);
      siteData.airports = [
        { name: "EDAV Halle-Oppin", lat: 51, lon: 12, country: "DE" },
      ];
      expect(countries.countCountries(["EDAV Halle-Oppin"]).size).toBe(1);
    });
  });

  describe("codeOwnerAt", () => {
    /** A press at a point of the screen, on `target` */
    function press(target: Element, detail = 1): MouseEvent {
      const event = new MouseEvent("click", {
        bubbles: true,
        clientX: 10,
        clientY: 10,
        detail,
      });
      Object.defineProperty(event, "target", { value: target });
      return event;
    }

    it("hands a press on another airport's code under a marker's square to that airport", () => {
      const pressed = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      const under = mod.createAirportElement("Egelsbach EDFE", "EDFE");
      const code = under.querySelector(".airport-code")!;
      const square = pressed.querySelector(".airport-marker-container")!;
      document.elementsFromPoint = () => [square, pressed, code, under];
      try {
        expect(mod.codeOwnerAt(press(square), pressed)).toBe("Egelsbach EDFE");
        // From the keyboard there is no point pressed
        expect(mod.codeOwnerAt(press(square, 0), pressed)).toBeNull();
        // On its own dot, or its own code, it is its own
        const dot = pressed.querySelector(".airport-marker")!;
        document.elementsFromPoint = () => [dot, square, code];
        expect(mod.codeOwnerAt(press(square), pressed)).toBeNull();
        const own = pressed.querySelector(".airport-code")!;
        expect(mod.codeOwnerAt(press(own), pressed)).toBeNull();
      } finally {
        Reflect.deleteProperty(document, "elementsFromPoint");
      }
    });
  });

  describe("createAirportElement", () => {
    it("builds a plain button named after the airport round its dot", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      const button = element.firstElementChild as HTMLButtonElement;

      // The class the airports toggle hides
      expect(element.className).toBe("airport-marker-root");
      expect(button).toBeInstanceOf(HTMLButtonElement);
      // Without it a button inside a form would submit
      expect(button.type).toBe("button");
      expect(button.title).toBe("Frankfurt EDDF");
      expect(button.getAttribute("aria-label")).toBe("Frankfurt EDDF");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(mod.airportControl(element)).toBe(button);
    });

    it("draws the dot and its code, and marks the home base", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF", true);
      const [container, arm] = element.children;

      expect(element.children).toHaveLength(2);
      expect(container!.className).toBe("airport-marker-container");
      expect(container!.firstElementChild!.className).toBe(
        "airport-marker airport-marker-home",
      );
      expect(element.classList.contains("is-home")).toBe(true);
      // Left out until it is placed (see ui/airportLabels.ts), and no part
      // of the button's name
      expect(arm!.className).toBe("airport-code-arm is-hidden");
      expect(arm!.getAttribute("aria-hidden")).toBe("true");
      expect([...arm!.children].map((child) => child.className)).toEqual([
        "airport-code-stem",
        "airport-code",
      ]);
      expect(arm!.querySelector(".airport-code")!.innerHTML).toBe(
        '<span class="airport-code-face">EDDF</span>',
      );
      expect(arm!.textContent).toBe("EDDF");
    });

    it("omits the home class for any other airport", () => {
      const element = mod.createAirportElement("Small Airfield 123", "APT");

      expect(element.querySelector(".airport-marker")).not.toBeNull();
      expect(element.querySelector(".airport-marker-home")).toBeNull();
    });

    it("does not read a name as markup", () => {
      const element = mod.createAirportElement(
        '<img src="x"> EDDF',
        "<b>EDDF</b>",
      );

      expect(element.querySelector("img, b")).toBeNull();
      expect(mod.airportControl(element).title).toBe('<img src="x"> EDDF');
      expect(element.textContent).toBe("<b>EDDF</b>");
    });
  });

  describe("setAirportTarget", () => {
    function parts(element: HTMLElement) {
      return {
        dot: element.querySelector<HTMLElement>(".airport-marker-container")!,
        chip: element.querySelector<HTMLElement>(".airport-code")!,
        arm: element.querySelector<HTMLElement>(".airport-code-arm")!,
      };
    }

    it("makes the chip the airport's one target, named after it, and back", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      const { dot, chip, arm } = parts(element);
      mod.setAirportExpanded(element, true, "popup");

      mod.setAirportTarget(element, { chip: true, half: null, out: false });
      expect(mod.airportControl(element)).toBe(chip);
      expect(chip.getAttribute("role")).toBe("button");
      expect(chip.tabIndex).toBe(0);
      expect(chip.getAttribute("aria-label")).toBe("Frankfurt EDDF");
      // The popup it has open, as the button has it
      expect(chip.getAttribute("aria-expanded")).toBe("true");
      expect(chip.getAttribute("aria-controls")).toBe("popup");
      expect(arm.hasAttribute("aria-hidden")).toBe(false);
      // The dot's square takes no pointer, no focus, no name
      expect(dot.hasAttribute("inert")).toBe(true);
      expect(chip.hasAttribute("inert")).toBe(false);

      mod.setAirportTarget(element, { chip: false, half: null, out: false });
      expect(mod.airportControl(element)).toBe(dot);
      expect(dot.hasAttribute("inert")).toBe(false);
      for (const name of ["role", "tabindex", "aria-label", "aria-expanded"]) {
        expect(chip.hasAttribute(name)).toBe(false);
      }
      expect(arm.getAttribute("aria-hidden")).toBe("true");
    });

    it("shrinks the square round the dot where a neighbour's is close", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");

      mod.setAirportTarget(element, { chip: false, half: 5, out: false });
      expect(element.style.getPropertyValue("--marker-target")).toBe("10px");
      mod.setAirportTarget(element, { chip: false, half: null, out: false });
      expect(element.style.getPropertyValue("--marker-target")).toBe("");
    });

    it("takes both parts out under a panel, and never the marker itself", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      const { dot, chip } = parts(element);

      mod.setAirportTarget(element, { chip: true, half: null, out: true });
      expect(dot.hasAttribute("inert")).toBe(true);
      expect(chip.hasAttribute("inert")).toBe(true);
      // A dialog's inert on the marker is the dialog's own
      element.setAttribute("inert", "");
      mod.setAirportTarget(element, { chip: false, half: null, out: false });
      expect(element.hasAttribute("inert")).toBe(true);
      expect(dot.hasAttribute("inert")).toBe(false);
    });

    it("hands the focus on to the new target", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      document.body.append(element);
      try {
        const { dot, chip } = parts(element);
        dot.focus();
        mod.setAirportTarget(element, { chip: true, half: null, out: false });
        expect(document.activeElement).toBe(chip);
        mod.setAirportTarget(element, { chip: false, half: null, out: false });
        expect(document.activeElement).toBe(dot);
      } finally {
        element.remove();
      }
    });

    it("lets Enter and Space press the chip while it is the target", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      const { chip } = parts(element);
      const clicks = vi.fn();
      chip.addEventListener("click", clicks);
      const key = (key: string): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", { key, cancelable: true });
        Object.defineProperty(event, "target", { value: chip });
        return event;
      };

      mod.onChipKey(key("Enter"));
      expect(clicks).not.toHaveBeenCalled();
      mod.setAirportTarget(element, { chip: true, half: null, out: false });
      const space = key(" ");
      mod.onChipKey(space);
      mod.onChipKey(key("Enter"));
      mod.onChipKey(key("a"));
      expect(clicks).toHaveBeenCalledTimes(2);
      expect(space.defaultPrevented).toBe(true);
    });
  });

  describe("setAirportElementHome", () => {
    it("switches the home-base classes on the same element", () => {
      const element = mod.createAirportElement("Frankfurt EDDF", "EDDF");
      const dot = element.querySelector(".airport-marker")!;

      mod.setAirportElementHome(element, true);
      expect(dot.classList.contains("airport-marker-home")).toBe(true);
      expect(element.classList.contains("is-home")).toBe(true);

      mod.setAirportElementHome(element, false);
      expect(dot.className).toBe("airport-marker");
      expect(element.classList.contains("is-home")).toBe(false);
      // Still the nodes it started with: focus and listeners stay
      expect(element.querySelector(".airport-marker")).toBe(dot);
    });
  });
});
