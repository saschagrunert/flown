/**
 * The flight list of an airport popup: the keyboard's way to one flight.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Popup } from "maplibre-gl";
import {
  listFlights,
  runwayUse,
} from "../../../../flown/frontend/ui/airportFlights";
import { flightLabel } from "../../../../flown/frontend/features/airports";
import { flightTotals } from "../../../../flown/frontend/calculations/flightTotals";
import type { PathInfo } from "../../../../flown/frontend/types";
import type { PickList } from "../../../../flown/frontend/ui/pathSelection";
import {
  asMapApp,
  createDataset,
  createMockApp,
  segmentOf,
  type MockApp,
} from "../../testHelpers";
import { Popup as MockPopup } from "../../../mocks/maplibre-gl";
import {
  resetSiteData,
  siteData,
} from "../../../../flown/frontend/state/siteData";

const pathInfo: PathInfo[] = [
  {
    id: 11,
    year: 2025,
    aircraft_registration: "D-EAGJ",
    start_airport: "EDAQ Halle-Oppin",
    end_airport: "EDDP Leipzig",
  },
  {
    id: 12,
    year: 2024,
    aircraft_registration: "D-ESST",
    start_airport: "EDDP Leipzig",
    end_airport: "EDAQ Halle-Oppin",
  },
  {
    id: 13,
    year: 2025,
    start_airport: "EDDP Leipzig",
    end_airport: "Somewhere <b>odd</b>",
  },
];

interface OpenPopup {
  popup: Popup;
  mock: MockPopup;
  container: HTMLElement;
}

describe("listFlights", () => {
  let mockApp: MockApp;

  /** The popup as AirportManager leaves it once the content is written */
  function openPopup(): OpenPopup {
    const mock = new MockPopup({ focusAfterOpen: false });
    mock
      .setLngLat([12, 51])
      .setHTML(
        '<div class="popup-container popup-airport" tabindex="-1"></div>',
      )
      .addTo(mockApp.map!);
    return {
      popup: mock as unknown as Popup,
      mock,
      container: mock.getElement(),
    };
  }

  function buttons(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".popup-flight")];
  }

  beforeEach(() => {
    // The codes the export found in the names; "Somewhere" has none
    siteData.airports = [
      { name: "EDAQ Halle-Oppin", lat: 51.55, lon: 12.05, code: "EDAQ" },
      { name: "EDDP Leipzig", lat: 51.42, lon: 12.24, code: "EDDP" },
      { name: "Somewhere <b>odd</b>", lat: 51, lon: 12 },
    ];
    document.body.innerHTML = '<div id="map"></div>';
    mockApp = createMockApp({
      currentData: createDataset(pathInfo),
      selectedYear: "all",
    });
  });

  afterEach(() => {
    resetSiteData();
  });

  it("names each flight by route, aircraft and year, and no distance it has not", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    expect(buttons(container).map((b) => b.textContent)).toEqual([
      "EDAQ → EDDP · D-EAGJ · 2025",
      "EDDP → EDAQ · D-ESST · 2024",
      // No code, no aircraft: the name stands in, escaped
      "EDDP → Somewhere <b>odd</b> · 2025",
    ]);
    expect(container.querySelector(".popup-flight b")).toBeNull();
    const list = container.querySelector(".popup-flights")!;
    expect(list.getAttribute("role")).toBe("group");
    expect(list.getAttribute("aria-label")).toBe("Flights");
    // Each with the checkbox that adds it, named after it
    expect(
      [...container.querySelectorAll(".pick-box")].map((box) =>
        box.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Select EDAQ → EDDP · D-EAGJ · 2025",
      "Select EDDP → EDAQ · D-ESST · 2024",
      "Select EDDP → Somewhere <b>odd</b> · 2025",
    ]);
  });

  it("tells flights of one route, aircraft and year apart by their distance", () => {
    const twice: PathInfo[] = [11, 14].map((id) => ({
      ...pathInfo[0]!,
      id,
    }));
    // One degree of latitude is 60 nm, half of one 30 nm
    mockApp.currentData = createDataset(twice, [
      segmentOf({
        path_id: 11,
        coords: [
          [51, 12],
          [52, 12],
        ],
      }),
      segmentOf({
        path_id: 14,
        coords: [
          [51, 12],
          [51.25, 12],
        ],
      }),
      segmentOf({
        path_id: 14,
        coords: [
          [51.25, 12],
          [51.5, 12],
        ],
      }),
    ]);
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    expect(buttons(container).map((b) => b.textContent)).toEqual([
      "EDAQ → EDDP · D-EAGJ · 2025 · 60 nm",
      "EDAQ → EDDP · D-EAGJ · 2025 · 30 nm",
    ]);
    expect(
      [...container.querySelectorAll(".pick-box")].map((box) =>
        box.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Select EDAQ → EDDP · D-EAGJ · 2025 · 60 nm",
      "Select EDAQ → EDDP · D-EAGJ · 2025 · 30 nm",
    ]);
  });

  it("names no distance under half a mile, rather than 0 nm", () => {
    const path = {
      id: 1,
      start_airport: "EDAQ",
      end_airport: "EDAQ",
      aircraft_registration: "D-EAGJ",
      year: 2025,
    } as PathInfo;

    expect(flightLabel(path, 0.4)).toBe("EDAQ → EDAQ · D-EAGJ · 2025");
    expect(flightLabel(path)).toBe("EDAQ → EDAQ · D-EAGJ · 2025");
    expect(flightLabel(path, 1.9)).toBe("EDAQ → EDAQ · D-EAGJ · 2025 · 1 nm");
  });

  it("lists only the flights the filter keeps", () => {
    mockApp.selectedYear = "2024";
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    expect(buttons(container)).toHaveLength(1);
  });

  it("leaves the layout and the pan to its caller", () => {
    const { popup, mock } = openPopup();
    mock.setLngLat.mockClear();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    expect(mock.setLngLat).not.toHaveBeenCalled();
    expect(mockApp.map!.panBy).not.toHaveBeenCalled();
  });

  it("adds nothing to a popup that closed while the bundle loaded", () => {
    const { popup, mock, container } = openPopup();
    mock.remove();
    // MapLibre drops the element of a closed popup; the mock keeps its own
    mock.getElement.mockReturnValue(undefined as unknown as HTMLDivElement);

    expect(() =>
      listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals),
    ).not.toThrow();

    expect(buttons(container)).toHaveLength(0);
  });

  it("does not list twice for the same content", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    expect(buttons(container)).toHaveLength(3);
  });

  it("stops the fade of its list as it closes, with one handler however often the list is written", () => {
    // Every change of the filter or the selection writes it again
    const { popup, mock } = openPopup();
    for (let i = 0; i < 3; i++) {
      mock.setHTML(
        '<div class="popup-container popup-airport" tabindex="-1"></div>',
      );
      listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);
    }

    expect(mock.listenerCount("close")).toBe(1);
  });

  it("adds no list to an airport without flights", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "LOWW Vienna", flightTotals);

    expect(container.querySelector(".popup-flights")).toBeNull();
  });

  it("hands a click on a row or its checkbox to the selection, with the list's order", () => {
    const { popup, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);
    const pick = mockApp.pathSelection.pickFromList;

    buttons(container)[1]!.click();
    container.querySelectorAll<HTMLElement>(".pick-box")[2]!.click();

    // What that means, with Shift, in share mode and during a replay, is
    // PathSelection's to say
    expect(
      (pick.mock.calls as [number, MouseEvent, PickList][]).map(
        ([id, event, list]) => [id, event.target, list.order],
      ),
    ).toEqual([
      [12, buttons(container)[1], [11, 12, 13]],
      [13, container.querySelectorAll(".pick-box")[2], [11, 12, 13]],
    ]);
  });

  it("marks the selected flights and follows the selection", () => {
    mockApp.selectedPathIds = new Set([11, 12]);
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    const pressed = (): (string | null)[] =>
      buttons(container).map((b) => b.getAttribute("aria-pressed"));
    const ticked = (): boolean[] =>
      [...container.querySelectorAll<HTMLInputElement>(".pick-box")].map(
        (box) => box.checked,
      );
    expect(pressed()).toEqual(["true", "true", "false"]);
    expect(ticked()).toEqual([true, true, false]);

    mockApp.selectedPathIds = new Set([13]);

    expect(pressed()).toEqual(["false", "false", "true"]);
    expect(ticked()).toEqual([false, false, true]);
  });

  it("draws every row unpressed while all of them are, as opening leaves them", () => {
    // Opening the popup selects the airport's flights, and every row read
    // as a choice already made
    mockApp.selectedPathIds = new Set([11, 12, 13]);
    const { popup, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);
    const list = container.querySelector(".popup-flights")!;

    // Still pressed for a screen reader
    expect(
      buttons(container).map((b) => b.getAttribute("aria-pressed")),
    ).toEqual(["true", "true", "true"]);
    expect(list.classList).toContain("is-all-pressed");

    mockApp.selectedPathIds = new Set([12]);

    expect(list.classList).not.toContain("is-all-pressed");
  });

  it("draws the one flight of an airport as it is, pressed or not", () => {
    // Drawn unpressed both ways, a press on it showed nothing
    mockApp.selectedPathIds = new Set([13]);
    const { popup, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "Somewhere <b>odd</b>", flightTotals);

    expect(buttons(container)).toHaveLength(1);
    expect(container.querySelector(".popup-flights")!.classList).not.toContain(
      "is-all-pressed",
    );
  });

  it("shows the runways the flights of the filter touched down on", () => {
    mockApp.currentData = createDataset([
      { ...pathInfo[0]!, touchdowns: [["EDDP", "26R"]] },
      {
        ...pathInfo[1]!,
        touchdowns: [
          ["EDDP", "08L"],
          ["EDDP", "26R"],
          ["EDAQ", "29"],
        ],
      },
      pathInfo[2]!,
    ]);
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    const labels = [...container.querySelectorAll(".popup-section-label")];
    expect(labels.map((label) => label.textContent)).toEqual([
      "Runways",
      "Flights",
    ]);
    const runways = labels[0]!.nextElementSibling!;
    expect(runways.className).toBe("popup-runways");
    expect(runways.textContent).toBe("RWY 26R · 67%, RWY 08L · 33%");
  });

  it("shows no runways where no flight has them", () => {
    const { popup, container } = openPopup();

    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);

    expect(container.textContent).not.toContain("Runways");
  });

  it("closes on Escape from anywhere inside the popup", () => {
    const { popup, mock, container } = openPopup();
    listFlights(asMapApp(mockApp), popup, "EDDP Leipzig", flightTotals);
    const flight = buttons(container)[0]!;

    flight.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(mock.isOpen()).toBe(true);

    flight.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(mock.isOpen()).toBe(false);
    expect(mock.remove).toHaveBeenCalledTimes(1);
  });
});

describe("runwayUse", () => {
  const flights: PathInfo[] = [
    {
      id: 1,
      touchdowns: [
        ["EDAQ", "29"],
        ["EDAQ", "29"],
        ["EDAQ", null],
      ],
    },
    {
      id: 2,
      touchdowns: [
        ["EDAQ", "11"],
        ["EDDP", "26R"],
      ],
    },
    { id: 3 },
  ];

  it("names the runways of one airport, the most used first", () => {
    expect(runwayUse(flights, "EDAQ")).toBe("RWY 29 · 67%, RWY 11 · 33%");
    expect(runwayUse(flights, "EDDP")).toBe("RWY 26R · 100%");
  });

  it("is empty without a code or without touchdowns there", () => {
    expect(runwayUse(flights, undefined)).toBe("");
    expect(runwayUse(flights, "LOWW")).toBe("");
    expect(runwayUse([], "EDAQ")).toBe("");
  });
});
