/**
 * The search of airports and places (ui/locationSearch.ts): the panel and
 * its combobox, the airports found as the visitor types, the places of
 * Photon after a pause, never twice for the same text and never for a text
 * the next one replaced, and what a pick does to the map. Photon is a
 * stand-in for fetch here; no test reaches it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AIRPORT_ZOOM,
  NOTHING_FOUND_MESSAGE,
  OFFLINE_MESSAGE,
  PLACE_TIMEOUT_MS,
  PLACES_FAILED_MESSAGE,
  SEARCH_BUTTON_ID,
  SEARCH_PANEL_ID,
  SEARCH_PIN_CLASS,
  SEARCHING_MESSAGE,
  SHORT_QUERY_MESSAGE,
  airportDetail,
  toggleSearch,
} from "../../../../flown/frontend/ui/locationSearch";
import { PLACE_DEBOUNCE_MS } from "../../../../flown/frontend/services/photon";
import {
  resetSiteData,
  siteData,
} from "../../../../flown/frontend/state/siteData";
import { announceStatus } from "../../../../flown/frontend/utils/toast";
import * as motion from "../../../../flown/frontend/utils/motion";
import type { Airport } from "../../../../flown/frontend/types";
import type { Map as MockMap } from "../../../mocks/maplibre-gl";
import { asMapApp, createMockApp, type MockApp } from "../../testHelpers";

vi.mock("../../../../flown/frontend/utils/toast", async (original) => ({
  ...(await original<
    typeof import("../../../../flown/frontend/utils/toast")
  >()),
  announceStatus: vi.fn(),
}));

const STUTTGART: Airport = {
  name: "EDDS Stuttgart",
  code: "EDDS",
  country: "DE",
  lat: 48.69,
  lon: 9.22,
};
const STRIP: Airport = { name: "Stuttgart strip", lat: 48.5, lon: 9.1 };

/** Photon's answer for "stuttgart": a city with its extent, a street without */
const PHOTON_ANSWER = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [9.18, 48.78] },
      properties: {
        name: "Stuttgart",
        type: "city",
        osm_value: "city",
        state: "Baden-Württemberg",
        country: "Germany",
        extent: [9.03, 48.87, 9.32, 48.69],
      },
    },
    {
      type: "Feature",
      geometry: { type: "Point", coordinates: [9.17, 48.77] },
      properties: {
        name: "Stuttgarter Straße",
        type: "street",
        osm_value: "residential",
        city: "Leonberg",
        country: "Germany",
      },
    },
  ],
};

/** A stand-in for fetch: Photon's answer, or what a test holds back */
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let lifetime: AbortController;
let app: MockApp;
let map: MockMap;

function answer(body: unknown = PHOTON_ANSWER): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const panel = (): HTMLElement => document.getElementById(SEARCH_PANEL_ID)!;
const input = (): HTMLInputElement =>
  panel().querySelector<HTMLInputElement>('[role="combobox"]')!;
const button = (): HTMLButtonElement =>
  document.getElementById(SEARCH_BUTTON_ID) as HTMLButtonElement;
const options = (): HTMLElement[] => [
  ...panel().querySelectorAll<HTMLElement>('[role="option"]'),
];
const optionNames = (): string[] =>
  options().map(
    (option) => option.querySelector(".location-search-name")!.textContent,
  );
const status = (): HTMLElement =>
  panel().querySelector<HTMLElement>(".location-search-status")!;
const pins = (): Element[] => [
  ...document.querySelectorAll(`.${SEARCH_PIN_CLASS}`),
];

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}

function key(name: string, target: EventTarget = input()): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

/** The last box the camera was fitted to, and how */
function lastFit(): {
  box: [[number, number], [number, number]];
  options: Record<string, unknown>;
} {
  const [box, options] = map.fitBounds.mock.calls.at(-1)! as [
    [[number, number], [number, number]],
    Record<string, unknown>,
  ];
  return { box, options };
}

/**
 * The end of the camera's last fit, which MapLibre fires with the
 * eventData the fit was given
 */
function arrive(): void {
  // The fake's fitBounds declares no eventData, which the search passes
  const call: unknown[] = map.fitBounds.mock.calls.at(-1)!;
  const eventData = call[2] as object;
  map.emit("moveend", eventData);
}

/**
 * A marker of the airport, as appInitializer makes them: its element, and
 * the button in it that takes the focus, which this returns
 */
function addMarker(airport: Airport): HTMLButtonElement {
  const element = document.createElement("div");
  const button = document.createElement("button");
  element.append(button);
  map.getCanvasContainer().append(element);
  app.airportMarkers[airport.name] = {
    getElement: () => element,
    getControl: () => button,
  } as unknown as MockApp["airportMarkers"][string];
  return button;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML =
    '<nav id="left-buttons"><button id="search-btn" aria-expanded="false">' +
    "Search</button></nav>" +
    '<main id="map-home"><div id="map"></div></main>';
  lifetime = new AbortController();
  app = createMockApp({ signal: lifetime.signal });
  map = app.map!;
  // A fit starts a move within the call, as MapLibre's does (the fake's
  // moves fire nothing), which arrive() ends
  const fit = map.fitBounds.getMockImplementation()!;
  map.fitBounds.mockImplementation((...args: Parameters<typeof fit>) => {
    const moved = fit(...args);
    map.emit("movestart", (args as unknown[])[2] ?? {});
    return moved;
  });
  siteData.airports = [STUTTGART, STRIP];
  fetcher = vi.fn<typeof fetch>(() => answer());
  vi.stubGlobal("fetch", fetcher);
  vi.mocked(announceStatus).mockClear();
});

afterEach(() => {
  // The app's lifetime ends, and the search with it
  lifetime.abort();
  resetSiteData();
  vi.useRealTimers();
});

describe("airportDetail", () => {
  it("names the country, and the code where the name does not", () => {
    expect(airportDetail(STUTTGART)).toBe("Germany");
    expect(airportDetail({ ...STUTTGART, name: "Stuttgart" })).toBe(
      "EDDS · Germany",
    );
    expect(airportDetail(STRIP)).toBe("");
  });
});

describe("opening and closing", () => {
  it("opens a panel ahead of the map with the focus in its field", () => {
    button().focus();
    toggleSearch(asMapApp(app));

    expect(panel().hidden).toBe(false);
    expect(panel().nextElementSibling?.id).toBe("map-home");
    expect(document.activeElement).toBe(input());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(button().getAttribute("aria-controls")).toBe(SEARCH_PANEL_ID);
    expect(button().classList.contains("active")).toBe(true);
    expect(panel().querySelector(".location-search-credit")!.textContent).toBe(
      "Search by Photon, data © OpenStreetMap",
    );
  });

  it("closes again and hands the focus back to what opened it", () => {
    button().focus();
    toggleSearch(asMapApp(app));
    toggleSearch(asMapApp(app));

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(button());
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("hands the focus to the map where the Search button is not shown", () => {
    // `/` with nothing focused, on a phone, where the column is not shown
    button().checkVisibility = () => false;
    toggleSearch(asMapApp(app));

    key("Escape");

    expect(document.activeElement).toBe(map.getCanvas());
  });

  it("closes with its close button", () => {
    toggleSearch(asMapApp(app));

    panel().querySelector<HTMLButtonElement>(".location-search-close")!.click();

    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(button());
  });

  it("closes with Escape, which goes no further", () => {
    toggleSearch(asMapApp(app));

    expect(key("Escape").defaultPrevented).toBe(true);
    expect(panel().hidden).toBe(true);
  });

  it("closes with Escape on its close button and its links too", () => {
    for (const selector of [
      ".location-search-close",
      ".location-search-credit a",
    ]) {
      toggleSearch(asMapApp(app));
      const part = panel().querySelector<HTMLElement>(selector)!;
      part.focus();

      expect(key("Escape", part).defaultPrevented).toBe(true);
      expect(panel().hidden).toBe(true);
      expect(document.activeElement).toBe(button());
    }
  });

  it("leaves an Escape the readout of the heat cloud took first", () => {
    toggleSearch(asMapApp(app));
    const readout = (event: KeyboardEvent): void => event.preventDefault();
    document.addEventListener("keydown", readout, true);

    key("Escape");

    document.removeEventListener("keydown", readout, true);
    expect(panel().hidden).toBe(false);
  });

  it("goes away at a press elsewhere, leaving the focus to it", () => {
    toggleSearch(asMapApp(app));

    // On its button the press is the toggle's
    button().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel().hidden).toBe(false);
    input().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel().hidden).toBe(false);

    map.getCanvas().dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).not.toBe(button());
  });

  it("stands beside the Search button where it is shown", () => {
    vi.spyOn(button(), "getBoundingClientRect").mockReturnValue({
      top: 52,
      right: 182,
      width: 172,
    } as DOMRect);

    toggleSearch(asMapApp(app));

    expect(panel().classList.contains("is-anchored")).toBe(true);
    expect(panel().style.getPropertyValue("--search-left")).toBe("190px");
    expect(panel().style.getPropertyValue("--search-top")).toBe("52px");
  });

  it("spans the top of the map where the button is hidden", () => {
    document.getElementById("left-buttons")!.hidden = true;

    toggleSearch(asMapApp(app));

    expect(panel().classList.contains("is-anchored")).toBe(false);
  });

  it("goes back to its field with `/` while open, rather than closing", () => {
    toggleSearch(asMapApp(app));
    // Focus left it without a next element, as the window lost it
    input().blur();

    toggleSearch(asMapApp(app), true);

    expect(panel().hidden).toBe(false);
    expect(document.activeElement).toBe(input());
  });

  it("follows the column as it scrolls, only while open", () => {
    const measure = vi.spyOn(button(), "getBoundingClientRect");
    const column = document.getElementById("left-buttons")!;
    toggleSearch(asMapApp(app));
    measure.mockClear();

    column.dispatchEvent(new Event("scroll"));
    expect(measure).toHaveBeenCalledTimes(1);

    toggleSearch(asMapApp(app));
    measure.mockClear();
    column.dispatchEvent(new Event("scroll"));
    expect(measure).not.toHaveBeenCalled();
  });

  it("goes away as the focus leaves it for the page, not for its own parts", () => {
    toggleSearch(asMapApp(app));
    const close = panel().querySelector<HTMLElement>(".location-search-close")!;

    close.focus();
    expect(panel().hidden).toBe(false);
    button().focus();
    expect(panel().hidden).toBe(false);

    input().focus();
    map.getCanvas().focus();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(map.getCanvas());
  });

  it("follows the column as the statistics open without a transition", () => {
    toggleSearch(asMapApp(app));
    const measure = vi.spyOn(button(), "getBoundingClientRect");

    app.statsPanelVisible = true;
    vi.advanceTimersToNextFrame();

    expect(measure).toHaveBeenCalled();
  });

  it("measures the button only while open, and as the column itself moves", () => {
    const measure = vi.spyOn(button(), "getBoundingClientRect");
    const column = document.getElementById("left-buttons")!;
    toggleSearch(asMapApp(app));
    toggleSearch(asMapApp(app));
    measure.mockClear();

    window.dispatchEvent(new Event("resize"));
    column.dispatchEvent(new Event("transitionend"));
    expect(measure).not.toHaveBeenCalled();

    toggleSearch(asMapApp(app));
    measure.mockClear();
    // A transition of one of its buttons, which bubbles up to it
    button().dispatchEvent(new Event("transitionend", { bubbles: true }));
    expect(measure).not.toHaveBeenCalled();
    column.dispatchEvent(new Event("transitionend"));
    window.dispatchEvent(new Event("resize"));
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("does not open while the map is held", () => {
    app.replayActive = true;

    toggleSearch(asMapApp(app));

    expect(panel().hidden).toBe(true);
  });

  it("closes as a replay, the tour or Wrapped takes the map", () => {
    for (const take of [
      () => (app.replayActive = true),
      () => (app.wrappedVisible = true),
    ]) {
      app.replayActive = false;
      app.wrappedVisible = false;
      toggleSearch(asMapApp(app));
      expect(panel().hidden).toBe(false);

      take();

      expect(panel().hidden).toBe(true);
    }
  });

  it("goes with the app", () => {
    toggleSearch(asMapApp(app));

    lifetime.abort();

    expect(document.getElementById(SEARCH_PANEL_ID)).toBeNull();
  });

  it("is made anew for another app", () => {
    toggleSearch(asMapApp(app));
    const first = panel();

    const other = createMockApp({ signal: lifetime.signal });
    toggleSearch(asMapApp(other));

    expect(first.isConnected).toBe(false);
    expect(panel()).not.toBe(first);
  });
});

describe("what it finds", () => {
  it("lists the airports as the visitor types, without asking Photon", () => {
    toggleSearch(asMapApp(app));

    type("ED");

    expect(optionNames()).toEqual(["EDDS Stuttgart"]);
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(
      panel().querySelector('[role="group"]')!.getAttribute("aria-label"),
    ).toBe("Airports");
    expect(status().hidden).toBe(true);
    expect(announceStatus).toHaveBeenLastCalledWith("1 airport");
    vi.runAllTimers();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("asks Photon nothing about the code or the name of an airport of the site", async () => {
    toggleSearch(asMapApp(app));

    for (const text of ["EDDS", "edds ", "EDDS Stuttgart", "stuttgart STRIP"]) {
      type(text);
      await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    }
    expect(fetcher).not.toHaveBeenCalled();

    // A part of a name is a place it may be
    type("Stuttgart");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("finds airports that loaded after the panel was made", () => {
    siteData.airports = null;
    toggleSearch(asMapApp(app));
    type("ED");
    expect(options()).toHaveLength(0);
    toggleSearch(asMapApp(app));

    siteData.airports = [STUTTGART];
    toggleSearch(asMapApp(app));

    expect(optionNames()).toEqual(["EDDS Stuttgart"]);
  });

  it("says when a text is too short for places and no airport has it", () => {
    toggleSearch(asMapApp(app));

    type("Zq");

    expect(status().hidden).toBe(false);
    expect(status().textContent).toBe(SHORT_QUERY_MESSAGE);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("says nothing for nothing typed", () => {
    toggleSearch(asMapApp(app));

    type("  ");

    expect(status().hidden).toBe(true);
    expect(announceStatus).not.toHaveBeenCalled();
  });

  it("asks Photon after a pause in the typing, and lists its places after the airports", async () => {
    toggleSearch(asMapApp(app));

    type("Stut");
    type("Stutt");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = new URL(fetcher.mock.calls[0]![0] as string);
    expect(url.host).toBe("photon.komoot.io");
    expect(url.searchParams.get("q")).toBe("stutt");

    await vi.waitFor(() => expect(options()).toHaveLength(4));
    // A name that starts with the text before one with a word that does
    expect(optionNames()).toEqual([
      "Stuttgart strip",
      "EDDS Stuttgart",
      "Stuttgart",
      "Stuttgarter Straße",
    ]);
    expect(
      options()[2]!.querySelector(".location-search-detail")!.textContent,
    ).toBe("City · Baden-Württemberg, Germany");
    expect(status().hidden).toBe(true);
    expect(announceStatus).toHaveBeenLastCalledWith("2 airports, 2 places");
  });

  it("says that it searches while Photon has not answered", async () => {
    fetcher.mockReturnValue(new Promise(() => {}));
    toggleSearch(asMapApp(app));

    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    expect(status().textContent).toBe(SEARCHING_MESSAGE);
  });

  it("says it failed when Photon does not answer in time", async () => {
    let held: AbortSignal | undefined;
    fetcher.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          held = init?.signal ?? undefined;
          held?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    toggleSearch(asMapApp(app));

    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    expect(status().textContent).toBe(SEARCHING_MESSAGE);
    await vi.advanceTimersByTimeAsync(PLACE_TIMEOUT_MS);

    expect(held?.aborted).toBe(true);
    expect(status().textContent).toBe(PLACES_FAILED_MESSAGE);
  });

  it("forgets a failure as the next request starts", async () => {
    fetcher.mockImplementationOnce(() =>
      Promise.reject(new TypeError("failed")),
    );
    toggleSearch(asMapApp(app));
    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    await vi.waitFor(() =>
      expect(status().textContent).toBe(PLACES_FAILED_MESSAGE),
    );

    // Enter tries again, and Photon answers this time
    key("Enter");
    expect(status().textContent).toBe(SEARCHING_MESSAGE);
    await vi.waitFor(() => expect(optionNames()).toContain("Stuttgart"));
    expect(status().hidden).toBe(true);
  });

  it("says that places failed along with the airports it lists", async () => {
    fetcher.mockImplementation(() => Promise.reject(new TypeError("failed")));
    toggleSearch(asMapApp(app));

    type("Stuttgart");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    await vi.waitFor(() =>
      expect(announceStatus).toHaveBeenLastCalledWith(
        `2 airports. ${PLACES_FAILED_MESSAGE}`,
      ),
    );
  });

  it("finds a word an input method is still composing, as Android's do", async () => {
    toggleSearch(asMapApp(app));
    input().value = "Stuttg";
    input().dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
    expect(optionNames()).toEqual(["Stuttgart strip", "EDDS Stuttgart"]);

    // Enter and Escape pick or drop the word, not an option or the panel
    for (const name of ["Enter", "Escape"]) {
      const event = new KeyboardEvent("keydown", {
        key: name,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      });
      input().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(panel().hidden).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    // Places after the pause, as for keystrokes
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("drops the request a newer text replaces", async () => {
    let held: AbortSignal | undefined;
    fetcher.mockImplementationOnce((_url, init) => {
      held = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    toggleSearch(asMapApp(app));

    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    expect(held?.aborted).toBe(false);

    type("Stuttgart");
    expect(held?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    await vi.waitFor(() => expect(optionNames()).toContain("Stuttgart"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("drops the request as the panel closes", async () => {
    let held: AbortSignal | undefined;
    fetcher.mockImplementationOnce((_url, init) => {
      held = init?.signal ?? undefined;
      return new Promise(() => {});
    });
    toggleSearch(asMapApp(app));
    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    toggleSearch(asMapApp(app));

    expect(held?.aborted).toBe(true);
  });

  it("asks once for a text, and has its places at once the next time", async () => {
    toggleSearch(asMapApp(app));
    type("Stuttgart");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    await vi.waitFor(() => expect(options()).toHaveLength(4));

    type("Berl");
    type("stuttgart ");

    expect(options()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("says when nothing is found", async () => {
    fetcher.mockImplementation(() => answer({ features: [] }));
    toggleSearch(asMapApp(app));

    type("Nowhere at all");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    await vi.waitFor(() =>
      expect(status().textContent).toBe(NOTHING_FOUND_MESSAGE),
    );
    expect(announceStatus).toHaveBeenLastCalledWith(NOTHING_FOUND_MESSAGE);
    // Enter asks nothing again for a text that was answered
    key("Enter");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("says quietly when Photon fails, and still finds the airports", async () => {
    fetcher.mockImplementation(() => Promise.reject(new TypeError("failed")));
    toggleSearch(asMapApp(app));

    type("Stuttgart");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    await vi.waitFor(() =>
      expect(status().textContent).toBe(PLACES_FAILED_MESSAGE),
    );
    expect(optionNames()).toEqual(["Stuttgart strip", "EDDS Stuttgart"]);
  });

  it("asks nothing while offline, and says so", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    toggleSearch(asMapApp(app));

    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    expect(fetcher).not.toHaveBeenCalled();
    expect(status().textContent).toBe(OFFLINE_MESSAGE);
    expect(announceStatus).toHaveBeenLastCalledWith(OFFLINE_MESSAGE);
  });

  it("says offline for a request that failed as the connection went", async () => {
    const online = vi.spyOn(navigator, "onLine", "get");
    fetcher.mockImplementation(() => {
      online.mockReturnValue(false);
      return Promise.reject(new TypeError("failed"));
    });
    toggleSearch(asMapApp(app));

    type("Berlin");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);

    await vi.waitFor(() => expect(status().textContent).toBe(OFFLINE_MESSAGE));
  });
});

describe("the keys", () => {
  it("move through the options, round from either end", () => {
    toggleSearch(asMapApp(app));
    type("Stuttgart");
    const active = (): string | null =>
      input().getAttribute("aria-activedescendant");

    expect(key("ArrowDown").defaultPrevented).toBe(true);
    expect(active()).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    key("ArrowDown");
    expect(active()).toBe(options()[1]!.id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("false");
    key("ArrowDown");
    expect(active()).toBe(options()[0]!.id);
    key("ArrowUp");
    expect(active()).toBe(options()[1]!.id);

    // A new text starts again with none
    type("Stuttgart s");
    expect(active()).toBeNull();
    key("ArrowUp");
    expect(active()).toBe(options().at(-1)!.id);
  });

  it("keep the active option as places arrive under it", async () => {
    toggleSearch(asMapApp(app));
    type("Stuttgart");
    key("ArrowDown");
    key("ArrowDown");
    expect(optionNames()[1]).toBe("EDDS Stuttgart");

    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    await vi.waitFor(() => expect(options()).toHaveLength(4));

    expect(input().getAttribute("aria-activedescendant")).toBe(
      options()[1]!.id,
    );
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    key("Enter");
    expect(announceStatus).toHaveBeenLastCalledWith("Showing EDDS Stuttgart");
  });

  it("do nothing with nothing listed", () => {
    toggleSearch(asMapApp(app));
    type("Zq");

    key("ArrowDown");

    expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("leave the other keys to the field", () => {
    toggleSearch(asMapApp(app));

    expect(key("a").defaultPrevented).toBe(false);
  });

  it("ask Photon at once on Enter while nothing is listed", async () => {
    toggleSearch(asMapApp(app));
    type("Berlin");

    key("Enter");
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Not again while that answer is on its way, nor after the pause
    key("Enter");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("a pick", () => {
  it("flies to an airport and opens its popup, without selecting its flights", () => {
    const marker = addMarker(STUTTGART);
    map.getBearing.mockReturnValue(30);
    toggleSearch(asMapApp(app));
    type("EDDS");

    key("Enter");

    expect(panel().hidden).toBe(true);
    const { box, options } = lastFit();
    expect((box[0][0] + box[1][0]) / 2).toBeCloseTo(STUTTGART.lon);
    expect((box[0][1] + box[1][1]) / 2).toBeCloseTo(STUTTGART.lat);
    expect(options).toMatchObject({
      maxZoom: AIRPORT_ZOOM,
      bearing: 30,
      animate: true,
    });
    // Clear of the panels over the map
    expect(Object.keys(options["padding"] as object).sort()).toEqual([
      "bottom",
      "left",
      "right",
      "top",
    ]);
    expect(app.airportManager.openPopup).not.toHaveBeenCalled();

    arrive();

    expect(app.airportManager.openPopup).toHaveBeenCalledWith(STUTTGART.name);
    expect(document.activeElement).toBe(marker);
    expect(app.airportManager.activateAirport).not.toHaveBeenCalled();
    expect(app.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
    expect(app.selectedPathIds.size).toBe(0);
    expect(pins()).toHaveLength(0);
    expect(announceStatus).toHaveBeenLastCalledWith("Showing EDDS Stuttgart");
  });

  it("marks an airport with a pulse where its marker is not shown", () => {
    addMarker(STUTTGART).parentElement!.hidden = true;
    toggleSearch(asMapApp(app));
    type("EDDS");
    key("Enter");

    arrive();

    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
    expect(pins()).toHaveLength(1);
    expect(document.activeElement).toBe(map.getCanvas());
  });

  it("marks an airport with a pulse while the airports are off", () => {
    addMarker(STUTTGART);
    app.airportsVisible = false;
    toggleSearch(asMapApp(app));
    type("EDDS");
    key("Enter");

    arrive();

    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
    expect(pins()).toHaveLength(1);
  });

  it("fits a place to its extent, marks it and gives the map the focus", async () => {
    toggleSearch(asMapApp(app));
    type("Stuttgart");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    await vi.waitFor(() => expect(options()).toHaveLength(4));

    options()[2]!.click();

    expect(panel().hidden).toBe(true);
    const { box, options: fit } = lastFit();
    expect(box).toEqual([
      [9.03, 48.69],
      [9.32, 48.87],
    ]);
    expect(fit["maxZoom"]).toBe(16);
    expect(pins()).toHaveLength(1);
    expect(document.activeElement).toBe(map.getCanvas());
    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
  });

  it("shows a place without an extent at the zoom of its kind", async () => {
    toggleSearch(asMapApp(app));
    type("Stuttgart");
    await vi.advanceTimersByTimeAsync(PLACE_DEBOUNCE_MS);
    await vi.waitFor(() => expect(options()).toHaveLength(4));

    key("ArrowUp");
    key("Enter");

    expect(lastFit().options["maxZoom"]).toBe(15);
  });

  it("jumps rather than flies under reduced motion", () => {
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
    toggleSearch(asMapApp(app));
    type("EDDS");

    key("Enter");

    expect(lastFit().options["animate"]).toBe(false);
  });

  it("keeps the focus in the field while an option is pressed", () => {
    toggleSearch(asMapApp(app));
    type("EDDS");
    const press = new Event("pointerdown", { bubbles: true, cancelable: true });

    options()[0]!.dispatchEvent(press);

    expect(press.defaultPrevented).toBe(true);
  });

  it("takes a click between the options for none", () => {
    toggleSearch(asMapApp(app));
    type("EDDS");

    panel().querySelector<HTMLElement>(".location-search-heading")!.click();

    expect(panel().hidden).toBe(false);
    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("forgets the popup of a pick the next one replaced", () => {
    addMarker(STUTTGART);
    toggleSearch(asMapApp(app));
    type("EDDS");
    key("Enter");

    toggleSearch(asMapApp(app));
    type("strip");
    key("Enter");
    arrive();

    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
    expect(pins()).toHaveLength(1);
  });

  it("takes the pulse away with the next pick, Escape or the close button", async () => {
    toggleSearch(asMapApp(app));
    type("strip");
    key("Enter");
    arrive();
    expect(pins()).toHaveLength(1);

    // The next pick
    toggleSearch(asMapApp(app));
    type("strip");
    key("Enter");
    expect(pins()).toHaveLength(0);
    arrive();
    expect(pins()).toHaveLength(1);

    // Escape on the page, once the panel is closed and every other
    // listener has had it
    key("Escape", document.body);
    expect(pins()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pins()).toHaveLength(0);

    // Escape in the panel, and its close button
    toggleSearch(asMapApp(app));
    type("strip");
    key("Enter");
    arrive();
    toggleSearch(asMapApp(app));
    key("Escape");
    expect(pins()).toHaveLength(0);
    await Promise.resolve();
  });

  it("takes the pulse away as a replay takes the map", () => {
    toggleSearch(asMapApp(app));
    type("strip");
    key("Enter");
    arrive();

    app.replayActive = true;

    expect(pins()).toHaveLength(0);
  });

  it("does nothing while the map is held", () => {
    toggleSearch(asMapApp(app));
    type("EDDS");
    // A tour that started under the open panel
    app.tourView = {} as NonNullable<MockApp["tourView"]>;

    key("Enter");

    expect(map.fitBounds).not.toHaveBeenCalled();
  });

  it("opens no popup and marks nothing once a mode took the map on the way", () => {
    addMarker(STUTTGART);
    toggleSearch(asMapApp(app));
    type("EDDS");
    key("Enter");

    // Replay all starts while the camera still flies there
    app.replayActive = true;
    arrive();

    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
    expect(pins()).toHaveLength(0);
    expect(map.listenerCount("moveend")).toBe(0);
  });

  it("keeps the focus in the field when opened again during the flight", () => {
    addMarker(STUTTGART);
    toggleSearch(asMapApp(app));
    type("EDDS");
    key("Enter");

    // `/` before the camera has arrived
    toggleSearch(asMapApp(app), true);
    arrive();

    expect(document.activeElement).toBe(input());
    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
  });

  it("waits for the end of its own move, not of the one it interrupted", () => {
    const marker = addMarker(STUTTGART);
    toggleSearch(asMapApp(app));
    type("EDDS");
    key("Enter");

    // The end of the drag's inertia the fit stopped: still far away
    map.emit("moveend");
    expect(app.airportManager.openPopup).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(map.getCanvas());

    arrive();
    expect(app.airportManager.openPopup).toHaveBeenCalledWith(STUTTGART.name);
    expect(document.activeElement).toBe(marker);
  });

  it("arrives at once where the fit does not move the map", () => {
    addMarker(STUTTGART);
    // No room for the box between the panels: MapLibre does nothing
    map.fitBounds.mockImplementation(() => map);
    toggleSearch(asMapApp(app));
    type("EDDS");

    key("Enter");

    expect(app.airportManager.openPopup).toHaveBeenCalledWith(STUTTGART.name);
    expect(map.listenerCount("moveend")).toBe(0);
  });

  it("leaves Escape to what took it, even after its own listener", async () => {
    toggleSearch(asMapApp(app));
    type("strip");
    key("Enter");
    arrive();
    // The cross-section, opened after the search was made, listens last
    const tool = (event: KeyboardEvent): void => event.preventDefault();
    window.addEventListener("keydown", tool);

    key("Escape", document.body);
    await vi.advanceTimersByTimeAsync(0);
    expect(pins()).toHaveLength(1);

    window.removeEventListener("keydown", tool);
    key("Escape", document.body);
    await vi.advanceTimersByTimeAsync(0);
    expect(pins()).toHaveLength(0);
  });

  it("uses the whole map where the panels leave no room for the fit", () => {
    // A map about 140 px tall: MapLibre finds no camera within the padding
    map.cameraForBounds.mockReturnValueOnce(
      undefined as unknown as ReturnType<typeof map.cameraForBounds>,
    );
    toggleSearch(asMapApp(app));
    type("EDDS");

    key("Enter");

    expect(lastFit().options["padding"]).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });
});
