import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FilterManager,
  YEAR_PICK_DELAY_MS,
  fitSelection,
} from "../../../../flown/frontend/ui/filterManager";
import type { KMLDataset } from "../../../../flown/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  announceStatus: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../flown/frontend/utils/toast", () => toastMock);
const loggerMock = vi.hoisted(() => ({ logError: vi.fn(), logDebug: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/logger", () => loggerMock);

describe("FilterManager", () => {
  let filterManager: FilterManager;
  let mockApp: MockApp;

  const allYearsData = (): KMLDataset =>
    createDataset(
      [
        {
          id: 1,
          year: 2025,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
        {
          id: 2,
          year: 2025,
          aircraft_registration: "D-EFGH",
          aircraft_type: "C172",
        },
        {
          id: 3,
          year: 2024,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
      ],
      [
        createSegment({ path_id: 1 }),
        createSegment({ path_id: 2 }),
        createSegment({ path_id: 3 }),
      ],
    );

  const year2024Data = (): KMLDataset =>
    createDataset(
      [
        {
          id: 3,
          year: 2024,
          aircraft_registration: "D-ABCD",
          aircraft_type: "DA40",
        },
      ],
      [createSegment({ path_id: 3 })],
    );

  function addYearOption(value: string): void {
    const yearSelect = document.getElementById(
      "year-select",
    ) as HTMLSelectElement;
    const option = document.createElement("option");
    option.value = value;
    yearSelect.appendChild(option);
  }

  function aircraftSelect(): HTMLSelectElement {
    return document.getElementById("aircraft-select") as HTMLSelectElement;
  }

  beforeEach(() => {
    const yearSelect = document.createElement("select");
    yearSelect.id = "year-select";
    yearSelect.innerHTML = '<option value="all">All Years</option>';
    document.body.appendChild(yearSelect);

    const select = document.createElement("select");
    select.id = "aircraft-select";
    select.innerHTML = '<option value="all">All Aircraft</option>';
    document.body.appendChild(select);

    mockApp = createMockApp({ currentData: allYearsData() });
    mockApp.dataManager.loadData.mockResolvedValue(allYearsData());
    filterManager = new FilterManager(asMapApp(mockApp));
    toastMock.showToast.mockClear();
  });

  afterEach(() => {
    document.getElementById("year-select")?.remove();
    document.getElementById("aircraft-select")?.remove();
  });

  describe("updateAircraftDropdown", () => {
    it("populates dropdown with aircraft from all years when year is 'all'", () => {
      mockApp.selectedYear = "all";

      filterManager.updateAircraftDropdown();

      const options = [...aircraftSelect().options].map((o) => o.value);
      expect(options).toEqual(["all", "D-ABCD", "D-EFGH"]);
    });

    it("populates dropdown with aircraft from selected year only", () => {
      mockApp.selectedYear = "2024";

      filterManager.updateAircraftDropdown();

      const options = [...aircraftSelect().options].map((o) => o.value);
      expect(options).toEqual(["all", "D-ABCD"]);
    });

    it("sorts aircraft by flight count descending", () => {
      mockApp.currentData = createDataset([
        { id: 1, year: 2025, aircraft_registration: "D-EFGH" },
        { id: 2, year: 2025, aircraft_registration: "D-ABCD" },
        { id: 3, year: 2025, aircraft_registration: "D-ABCD" },
      ]);

      filterManager.updateAircraftDropdown();

      const options = [...aircraftSelect().options].map((o) => o.value);
      expect(options).toEqual(["all", "D-ABCD", "D-EFGH"]);
    });

    it("includes aircraft type in option text if available", () => {
      filterManager.updateAircraftDropdown();

      expect(aircraftSelect().options[1]!.textContent).toBe("D-ABCD (DA40)");
    });

    it("clears previously added options", () => {
      filterManager.updateAircraftDropdown();
      filterManager.updateAircraftDropdown();

      expect(aircraftSelect().options).toHaveLength(3);
    });

    it("resets to 'all' if current selection doesn't exist in filtered list", () => {
      mockApp.selectedAircraft = "D-NONEXISTENT";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("all");
      expect(aircraftSelect().value).toBe("all");
      // Said out loud: the recipient of a shared link would otherwise see
      // every aircraft without knowing that the link's filter was dropped
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "D-NONEXISTENT has no flights in the loaded years, showing all aircraft",
        "info",
      );
    });

    it("names the year the aircraft did not fly in", () => {
      mockApp.selectedYear = "2024";
      mockApp.selectedAircraft = "D-EFGH";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("all");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "D-EFGH has no flights in 2024, showing all aircraft",
        "info",
      );
    });

    it("says nothing when the selection is kept or was 'all'", () => {
      filterManager.updateAircraftDropdown();
      mockApp.selectedAircraft = "D-ABCD";
      filterManager.updateAircraftDropdown();

      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("preserves current selection if it exists in filtered list", () => {
      mockApp.selectedAircraft = "D-ABCD";

      filterManager.updateAircraftDropdown();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
      expect(aircraftSelect().value).toBe("D-ABCD");
    });

    it("does nothing if no data is loaded", () => {
      mockApp.currentData = null;

      filterManager.updateAircraftDropdown();

      expect(aircraftSelect().options).toHaveLength(1);
    });

    it("does nothing if aircraft select element doesn't exist", () => {
      document.getElementById("aircraft-select")?.remove();

      expect(() => filterManager.updateAircraftDropdown()).not.toThrow();
    });
  });

  /** Called once per update of what the layers draw, as DataManager is */
  const followDrawnKeys = (): ReturnType<typeof vi.fn> => {
    const listener = vi.fn();
    mockApp.store.subscribeKeys(
      [
        "currentData",
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "isolateSelection",
      ],
      listener,
    );
    return listener;
  };

  describe("filterByYear", () => {
    it("updates selected year from dropdown value and loads it first", async () => {
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect(mockApp.selectedYear).toBe("2024");
      expect(mockApp.dataManager.loadData).toHaveBeenCalledWith(
        "2024",
        expect.any(AbortSignal),
        expect.objectContaining({ label: "Retry" }),
      );
      expect(mockApp.currentData).toEqual(year2024Data());
    });

    it("renders the full new year when the selected aircraft did not fly that year (regression)", async () => {
      // 2025 with D-EFGH selected, switch to 2024 where only D-ABCD flew
      mockApp.selectedYear = "2025";
      mockApp.selectedAircraft = "D-EFGH";
      aircraftSelect().innerHTML =
        '<option value="all">All Aircraft</option><option value="D-EFGH">D-EFGH</option>';
      aircraftSelect().value = "D-EFGH";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      const order: string[] = [];
      mockApp.dataManager.loadData.mockImplementation(() => {
        order.push("loadData");
        return Promise.resolve(year2024Data());
      });
      // The layers are drawn when the dataset is published (DataManager
      // follows the store)
      mockApp.store.subscribe("currentData", () => {
        order.push(`draw:${mockApp.selectedAircraft}`);
      });

      await filterManager.filterByYear();

      // Aircraft reset to "all" BEFORE the layers are drawn, so the map is not empty
      expect(mockApp.selectedAircraft).toBe("all");
      expect(aircraftSelect().value).toBe("all");
      expect(order).toEqual(["loadData", "draw:all"]);
    });

    it("publishes the year, the data and the aircraft list in one flush", async () => {
      mockApp.selectedAircraft = "D-EFGH";
      aircraftSelect().innerHTML =
        '<option value="all">All Aircraft</option><option value="D-EFGH">D-EFGH</option>';
      aircraftSelect().value = "D-EFGH";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      const newData = year2024Data();
      mockApp.dataManager.loadData.mockResolvedValue(newData);
      // What a listener sees when it is told about the year
      const seen: { data: KMLDataset | null; aircraft: string }[] = [];
      mockApp.store.subscribe("selectedYear", () => {
        seen.push({
          data: mockApp.currentData,
          aircraft: mockApp.selectedAircraft,
        });
      });

      await filterManager.filterByYear();

      // Never a new year with the old data or an aircraft that did not fly
      expect(seen).toEqual([{ data: newData, aircraft: "all" }]);
    });

    it("keeps the aircraft selection when it exists in the new year", async () => {
      mockApp.selectedAircraft = "D-ABCD";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
    });

    it("keeps the selected flights the new year shows and drops the others", async () => {
      // It cleared them all, also the ones of the year picked
      mockApp.selectedPathIds = new Set([1, 3]);
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      await filterManager.filterByYear();

      expect([...mockApp.selectedPathIds]).toEqual([3]);
      expect(listener).toHaveBeenCalled();
      // Said, rather than gone without a word
      // Said as it is: the file of 2024 cannot tell another year's flight
      // from one the site lost
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "1 selected flight is not in 2024 and was deselected",
      );
    });

    it("says how many selected flights the year lacks", async () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect(toastMock.showToast).toHaveBeenCalledWith(
        "2 selected flights are not in 2024 and were deselected",
      );
    });

    it("keeps every shared flight, the ones the year hides as well", async () => {
      // The flights of a day shared from all years, and then their year
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      mockApp.isolateSelection = true;
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      // The shared set is fixed: the link hands both on, and the chip says
      // the filter hides one
      expect([...mockApp.selectedPathIds]).toEqual([1, 3]);
      expect(mockApp.isolateSelection).toBe(true);
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("keeps share mode where the year hides every shared flight", async () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await filterManager.filterByYear();

      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(mockApp.isolateSelection).toBe(true);
    });

    it("picks the year it is given and changes more of the store in the same flush", async () => {
      // What Reset view does: from 2024 and a registration that did not fly
      // in 2025, back to 2025 and every aircraft
      mockApp.selectedYear = "2024";
      mockApp.selectedAircraft = "D-XXXX";
      mockApp.heatmapVisible = false;
      addYearOption("2024");
      addYearOption("2025");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      const listener = vi.fn();
      mockApp.store.subscribeKeys(
        ["selectedYear", "selectedAircraft", "heatmapVisible"],
        listener,
      );

      const applied = await filterManager.filterByYear("2025", () => {
        mockApp.selectedAircraft = "all";
        mockApp.heatmapVisible = true;
      });

      expect(applied).toBe(true);
      expect(yearSelect.value).toBe("2025");
      // A Reset view is more than the switch; its button is the retry
      expect(mockApp.dataManager.loadData).toHaveBeenCalledWith(
        "2025",
        expect.any(AbortSignal),
        undefined,
      );
      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.heatmapVisible).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // The aircraft went back before the list was rebuilt, so the
      // registration that did not fly is not reported as dropped
      expect(mockApp.selectedAircraft).toBe("all");
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("changes nothing more when the year it is given fails to load", async () => {
      mockApp.heatmapVisible = false;
      mockApp.dataManager.loadData.mockResolvedValue(null);
      const also = vi.fn();

      const applied = await filterManager.filterByYear("all", also);

      // Reset view relies on this to leave the rest alone too
      expect(applied).toBe(false);
      expect(also).not.toHaveBeenCalled();
      expect(mockApp.heatmapVisible).toBe(false);
    });

    it("puts the dropdown back and leaves the store alone when the year fails to load", async () => {
      const previous = mockApp.currentData;
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValue(null);
      const listener = followDrawnKeys();
      const bar = { refreshSheet: vi.fn() };
      mockApp.mobileBar = bar as unknown as MockApp["mobileBar"];

      await filterManager.filterByYear();

      // The map still shows 2025, so the dropdown says so too
      expect(mockApp.selectedYear).toBe("2025");
      expect(yearSelect.value).toBe("2025");
      expect(mockApp.currentData).toBe(previous);
      expect(listener).not.toHaveBeenCalled();
      // The Filter sheet mirrors the dropdown, not the store, which did not
      // change; without this it kept showing the year that failed
      expect(bar.refreshSheet).toHaveBeenCalledTimes(1);
    });

    it("discards stale completions when a newer year change arrives", async () => {
      addYearOption("2024");
      addYearOption("2025");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      let resolveFirst: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData
        .mockImplementationOnce(
          () =>
            new Promise<KMLDataset>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValueOnce(allYearsData());
      const redraws = followDrawnKeys();

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      yearSelect.value = "2025";
      const second = filterManager.filterByYear();

      expect(await second).toBe(true);
      resolveFirst(year2024Data());
      // Reset view relies on this to leave the camera to the newer change
      expect(await first).toBe(false);

      expect(mockApp.selectedYear).toBe("2025");
      expect(redraws).toHaveBeenCalledTimes(1);
      // The newer change owns the dropdown
      expect(yearSelect.value).toBe("2025");
    });

    it("abandons the load of a year change that a newer one replaced", async () => {
      addYearOption("2024");
      addYearOption("2025");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());
      const signalOf = (call: number): AbortSignal =>
        mockApp.dataManager.loadData.mock.calls[call]![1] as AbortSignal;

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      yearSelect.value = "2025";
      const second = filterManager.filterByYear();
      await Promise.all([first, second]);

      expect(signalOf(0).aborted).toBe(true);
      expect(signalOf(1).aborted).toBe(false);
    });

    it("leaves the dropdown to a newer year change that is still loading", async () => {
      addYearOption("2024");
      addYearOption("2023");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      let resolveFirst: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData
        .mockImplementationOnce(
          () =>
            new Promise<KMLDataset>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockImplementationOnce(() => new Promise<KMLDataset>(() => {}));

      yearSelect.value = "2024";
      const first = filterManager.filterByYear();
      // Back to a year that is still being requested by the first change
      yearSelect.value = "2023";
      void filterManager.filterByYear();
      yearSelect.value = "2024";
      void filterManager.filterByYear();
      resolveFirst(year2024Data());
      await first;

      expect(yearSelect.value).toBe("2024");
    });

    it("retries the switch from the toast of its failure", async () => {
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValueOnce(null);
      await filterManager.filterByYear();
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { run: () => void },
      ];
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      retry.run();

      await vi.waitFor(() => expect(mockApp.selectedYear).toBe("2024"));
    });

    it("keeps showing the year that failed when a switch fails with nothing loaded", async () => {
      // The first load failed, and so did the next year picked: the note
      // on the map names it and loads it again (see loadShownYear). The
      // dropdown showed an empty "Year" instead.
      mockApp.currentData = null;
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValue(null);
      const bar = { refreshSheet: vi.fn() };
      mockApp.mobileBar = bar as unknown as MockApp["mobileBar"];

      await filterManager.filterByYear();

      expect(yearSelect.value).toBe("2024");
      expect([...yearSelect.options].some((option) => option.disabled)).toBe(
        false,
      );
      expect(bar.refreshSheet).toHaveBeenCalled();
    });

    it("retries the year the dropdown shows, the last that failed", async () => {
      mockApp.currentData = null;
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      expect(await filterManager.loadShownYear()).toBe(true);

      expect(mockApp.dataManager.loadData.mock.calls[0]![0]).toBe("2024");
      expect(mockApp.selectedYear).toBe("2024");
    });

    it("retries the year that failed and keeps the selection it can", async () => {
      // The page was opened with a selection the failed load never checked
      mockApp.currentData = null;
      mockApp.selectedYear = "2024";
      addYearOption("2024");
      (document.getElementById("year-select") as HTMLSelectElement).value =
        "2024";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 99]);
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      expect(await filterManager.loadShownYear()).toBe(true);

      expect(mockApp.dataManager.loadData.mock.calls[0]![0]).toBe("2024");
      // The panel on the map offers the retry, so its toast does not
      expect(mockApp.dataManager.loadData.mock.calls[0]![2]).toBeUndefined();
      expect(mockApp.currentData).toEqual(year2024Data());
      expect([...mockApp.selectedPathIds]).toEqual([3]);
      // A dataset of one year cannot tell a flight of another from one the
      // site lost, and says so (see the next test for every year)
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "1 selected flight is not in 2024 and was deselected",
      );
    });

    it("retries every year and says what the link named that the site lost", async () => {
      mockApp.currentData = null;
      mockApp.selectedYear = "all";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 99]);
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      expect(await filterManager.loadShownYear()).toBe(true);

      expect([...mockApp.selectedPathIds]).toEqual([3]);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Left out 1 flight not on this site",
      );
    });

    it("offers a Retry for the years a first load of all years did not bring", async () => {
      // Some years came, the panel went, and the toast that named the
      // others had nothing to load them again with
      mockApp.currentData = null;
      mockApp.selectedYear = "all";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      mockApp.dataManager.loadData.mockResolvedValue({
        ...year2024Data(),
        incomplete: true,
      });
      await filterManager.loadShownYear();
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { label: string; run: () => boolean | void } | undefined,
      ];
      expect(retry?.label).toBe("Retry");
      mockApp.dataManager.loadData.mockClear();
      mockApp.dataManager.loadData.mockResolvedValue(allYearsData());

      expect(retry!.run()).toBe(true);
      await vi.waitFor(() =>
        expect(mockApp.currentData).toEqual(allYearsData()),
      );

      expect(mockApp.dataManager.loadData.mock.calls[0]![0]).toBe("all");
      expect(mockApp.selectedYear).toBe("all");
      expect([...mockApp.selectedPathIds]).toEqual([3]);
    });

    it("says which year it shows once the switch is applied", async () => {
      addYearOption("2024");

      await filterManager.filterByYear("2024");

      expect(toastMock.announceStatus).toHaveBeenCalledWith("Showing 2024");
    });

    it("keeps the toast of a failed switch whose Retry is pressed during a replay", async () => {
      addYearOption("2024");
      mockApp.dataManager.loadData.mockResolvedValue(null);
      await filterManager.filterByYear("2024");
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { run: () => boolean | void },
      ];
      mockApp.replayActive = true;
      mockApp.dataManager.loadData.mockClear();

      // False keeps the toast: the failure was lost to a press that did
      // nothing (regression)
      expect(retry.run()).toBe(false);
      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Stop the replay to load 2024 again",
        "info",
      );

      mockApp.replayActive = false;
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());
      expect(retry.run()).toBe(true);
      expect(mockApp.dataManager.loadData).toHaveBeenCalledTimes(1);
    });

    it("gives way to a replay that starts while the year loads", async () => {
      // The switch used to land in the middle of the replay: the selection
      // it played went, and the statistics reset under it
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      const previous = mockApp.currentData;
      let resolve: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData.mockImplementation(
        () =>
          new Promise<KMLDataset>((r) => {
            resolve = r;
          }),
      );

      yearSelect.value = "2024";
      const pending = filterManager.filterByYear();
      mockApp.replayActive = true;
      const signal = mockApp.dataManager.loadData.mock
        .calls[0]![1] as AbortSignal;

      // The dropdown shows the year the replay plays in again
      expect(yearSelect.value).toBe("2025");
      expect(signal.aborted).toBe(true);
      resolve(year2024Data());
      expect(await pending).toBe(false);
      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.currentData).toBe(previous);
      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });

    it("gives way to the hotspot tour that starts while the year loads", async () => {
      // The switch landed as the tour ran and ended it with other flights
      const tourView = {
        center: { lat: 51, lng: 12 },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
      };
      mockApp.selectedYear = "2025";
      addYearOption("2025");
      addYearOption("2024");
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      const previous = mockApp.currentData;
      let resolve: (d: KMLDataset) => void = () => {};
      mockApp.dataManager.loadData.mockImplementation(
        () =>
          new Promise<KMLDataset>((r) => {
            resolve = r;
          }),
      );

      yearSelect.value = "2024";
      const pending = filterManager.filterByYear();
      mockApp.tourView = tourView;

      expect(yearSelect.value).toBe("2025");
      resolve(year2024Data());
      expect(await pending).toBe(false);
      expect(mockApp.currentData).toBe(previous);

      // A pick that waits for the next one is dropped as well
      vi.useFakeTimers();
      try {
        mockApp.tourView = null;
        mockApp.dataManager.loadData.mockClear();
        yearSelect.value = "2024";
        filterManager.pickYear();
        mockApp.tourView = tourView;
        await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);
        expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves a running replay alone when the toast's Retry is pressed", async () => {
      // The toast of a failed switch stays into a replay, and its Retry
      // swapped the dataset under the flight being played
      addYearOption("2025");
      addYearOption("2024");
      mockApp.selectedYear = "2025";
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValueOnce(null);
      await filterManager.filterByYear();
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { run: () => void },
      ];
      const previous = mockApp.currentData;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.replayActive = true;
      mockApp.dataManager.loadData.mockClear();
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      retry.run();
      await Promise.resolve();

      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
      expect(yearSelect.value).toBe("2025");
      expect(mockApp.selectedYear).toBe("2025");
      expect(mockApp.currentData).toBe(previous);
      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });

    it("holds the toast's Retry and a year switch while the hotspot tour runs", async () => {
      // The Retry of a toast still on screen swapped the dataset under the
      // tour, which ended it with "return" (regression)
      addYearOption("2025");
      addYearOption("2024");
      mockApp.selectedYear = "2025";
      const yearSelect = document.getElementById(
        "year-select",
      ) as HTMLSelectElement;
      yearSelect.value = "2024";
      mockApp.dataManager.loadData.mockResolvedValueOnce(null);
      await filterManager.filterByYear();
      const [, , retry] = mockApp.dataManager.loadData.mock.calls[0] as [
        string,
        AbortSignal,
        { run: () => boolean | void },
      ];
      const previous = mockApp.currentData;
      mockApp.tourView = {
        center: { lat: 51, lng: 12 },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
      };
      mockApp.dataManager.loadData.mockClear();
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      expect(retry.run()).toBe(false);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Stop the tour to load 2024 again",
        "info",
      );
      expect(await filterManager.filterByYear("2024")).toBe(false);
      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
      expect(mockApp.currentData).toBe(previous);
      expect(mockApp.selectedYear).toBe("2025");

      mockApp.tourView = null;
      expect(retry.run()).toBe(true);
      expect(mockApp.dataManager.loadData).toHaveBeenCalledTimes(1);
    });

    it("does nothing if year select element doesn't exist", async () => {
      document.getElementById("year-select")?.remove();
      const redraws = followDrawnKeys();

      await filterManager.filterByYear();

      expect(redraws).not.toHaveBeenCalled();
      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
    });
  });

  describe("filterByAircraft", () => {
    it("updates selected aircraft from dropdown value, in one update", () => {
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      const redraws = followDrawnKeys();

      filterManager.filterByAircraft();

      expect(mockApp.selectedAircraft).toBe("D-ABCD");
      expect(redraws).toHaveBeenCalledTimes(1);
    });

    it("drops the flights it no longer shows in the same flush as the aircraft change", () => {
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      const seen: number[] = [];
      mockApp.store.subscribe("selectedAircraft", () => {
        seen.push(mockApp.selectedPathIds.size);
      });

      filterManager.filterByAircraft();

      expect(seen).toEqual([0]);
    });

    it("keeps the selected flights of the aircraft picked", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      const select = aircraftSelect();
      select.add(new Option("D-ABCD", "D-ABCD"));
      select.value = "D-ABCD";

      filterManager.filterByAircraft();

      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });

    it("keeps every shared flight, the ones of another aircraft as well", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.isolateSelection = true;
      const select = aircraftSelect();
      select.add(new Option("D-ABCD", "D-ABCD"));
      select.value = "D-ABCD";

      filterManager.filterByAircraft();

      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);
      expect(mockApp.isolateSelection).toBe(true);
    });

    it("keeps the selected flights a year that failed to load may hold", () => {
      // A link to all years with one of them missing: its flights are not
      // in the dataset, and a Retry would bring them
      mockApp.currentData = { ...mockApp.currentData!, incomplete: true };
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 99]);
      const select = aircraftSelect();
      select.add(new Option("D-ABCD", "D-ABCD"));
      select.value = "D-ABCD";

      filterManager.filterByAircraft();

      // The flight of another aircraft goes, the unknown one stays
      expect([...mockApp.selectedPathIds]).toEqual([99]);
    });

    it("keeps every selected flight for every aircraft", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      const updates = vi.fn();
      mockApp.store.subscribe("selectedPathIds", updates);

      filterManager.filterByAircraft();

      expect(mockApp.selectedPathIds.size).toBe(2);
      expect(updates).not.toHaveBeenCalled();
    });

    it("keeps share mode with its one flight of another aircraft", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.isolateSelection = true;
      const select = aircraftSelect();
      const option = document.createElement("option");
      option.value = "D-ABCD";
      select.appendChild(option);
      select.value = "D-ABCD";
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () => {
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]);
      });

      filterManager.filterByAircraft();

      // It left share mode with its flight, which the link then lost
      expect(seen).toEqual([]);
      expect([...mockApp.selectedPathIds]).toEqual([2]);
      expect(mockApp.isolateSelection).toBe(true);
    });

    describe("while a year switch loads", () => {
      let yearSelect: HTMLSelectElement;
      let resolveYear: (d: KMLDataset | null) => void;

      beforeEach(() => {
        addYearOption("2024");
        yearSelect = document.getElementById(
          "year-select",
        ) as HTMLSelectElement;
        resolveYear = () => {};
        mockApp.dataManager.loadData.mockImplementationOnce(
          () =>
            new Promise<KMLDataset | null>((resolve) => {
              resolveYear = resolve;
            }),
        );
      });

      function pickAircraft(registration: string): void {
        const select = aircraftSelect();
        const option = document.createElement("option");
        option.value = registration;
        select.appendChild(option);
        select.value = registration;
        filterManager.filterByAircraft();
      }

      it("applies the aircraft with the year, in one flush", async () => {
        const redraws = followDrawnKeys();

        yearSelect.value = "2024";
        const pendingYear = filterManager.filterByYear();
        pickAircraft("D-ABCD");
        // Nothing yet: the aircraft goes in with the year
        expect(mockApp.selectedAircraft).toBe("all");
        resolveYear(year2024Data());

        // The year used to be thrown away silently (regression)
        expect(await pendingYear).toBe(true);
        expect(mockApp.selectedYear).toBe("2024");
        expect(mockApp.selectedAircraft).toBe("D-ABCD");
        expect(redraws).toHaveBeenCalledTimes(1);
        expect(yearSelect.value).toBe("2024");
      });

      it("says so when the new year has no flights of the aircraft", async () => {
        yearSelect.value = "2024";
        const pendingYear = filterManager.filterByYear();
        pickAircraft("D-EFGH");
        resolveYear(year2024Data());
        await pendingYear;

        expect(mockApp.selectedYear).toBe("2024");
        expect(mockApp.selectedAircraft).toBe("all");
        expect(toastMock.showToast).toHaveBeenCalledWith(
          "D-EFGH has no flights in 2024, showing all aircraft",
          "info",
        );
      });

      it("applies the aircraft to the year still shown when the switch fails", async () => {
        yearSelect.value = "2024";
        const pendingYear = filterManager.filterByYear();
        pickAircraft("D-ABCD");
        resolveYear(null);
        await pendingYear;

        expect(mockApp.selectedYear).toBe("all");
        expect(mockApp.selectedAircraft).toBe("D-ABCD");
      });

      it("drops the aircraft when a replay cancels the switch", async () => {
        yearSelect.value = "2024";
        const pendingYear = filterManager.filterByYear();
        pickAircraft("D-ABCD");
        filterManager.cancelPending();
        resolveYear(year2024Data());
        await pendingYear;

        expect(mockApp.selectedYear).toBe("all");
        expect(mockApp.selectedAircraft).toBe("all");
      });
    });

    it("does nothing if aircraft select element doesn't exist", () => {
      document.getElementById("aircraft-select")?.remove();
      const redraws = followDrawnKeys();

      filterManager.filterByAircraft();

      expect(redraws).not.toHaveBeenCalled();
    });
  });

  describe("pickYear", () => {
    function yearSelect(): HTMLSelectElement {
      return document.getElementById("year-select") as HTMLSelectElement;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      for (const year of ["2026", "2025", "2024"]) addYearOption(year);
      loggerMock.logError.mockClear();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("loads the year the dropdown stops at, not every one it passed", async () => {
      // The arrow keys on a closed dropdown change it at every step
      for (const year of ["2026", "2025", "2024"]) {
        yearSelect().value = year;
        filterManager.pickYear();
        await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS / 2);
      }
      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);

      expect(mockApp.dataManager.loadData).toHaveBeenCalledExactlyOnceWith(
        "2024",
        expect.any(AbortSignal),
        expect.anything(),
      );
    });

    it("gives way to a switch that does not wait", async () => {
      yearSelect().value = "2026";
      filterManager.pickYear();

      await filterManager.filterByYear("2025");
      await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);

      expect(mockApp.dataManager.loadData).toHaveBeenCalledTimes(1);
      expect(mockApp.selectedYear).toBe("2025");
    });

    it("is dropped with what a replay cancels", async () => {
      yearSelect().value = "2026";
      filterManager.pickYear();

      filterManager.cancelPending();
      await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);

      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
      expect(yearSelect().value).toBe("all");
    });

    it("takes an aircraft picked while it waits along with the year", async () => {
      yearSelect().value = "2024";
      filterManager.pickYear();
      aircraftSelect().add(new Option("D-ABCD", "D-ABCD"));
      aircraftSelect().value = "D-ABCD";
      filterManager.filterByAircraft();
      expect(mockApp.selectedAircraft).toBe("all");
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());

      await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);

      expect(mockApp.selectedYear).toBe("2024");
      expect(mockApp.selectedAircraft).toBe("D-ABCD");
    });

    it("does nothing once the app is gone", async () => {
      const lifetime = new AbortController();
      mockApp = createMockApp({ signal: lifetime.signal });
      filterManager = new FilterManager(asMapApp(mockApp));
      yearSelect().value = "2026";
      filterManager.pickYear();

      lifetime.abort();
      await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);

      expect(mockApp.dataManager.loadData).not.toHaveBeenCalled();
    });

    it("logs a switch that failed instead of throwing", async () => {
      const error = new Error("filter failed");
      mockApp.dataManager.loadData.mockRejectedValueOnce(error);
      yearSelect().value = "2026";
      filterManager.pickYear();

      await vi.advanceTimersByTimeAsync(YEAR_PICK_DELAY_MS);

      expect(loggerMock.logError).toHaveBeenCalledWith(error);
    });
  });

  describe("loading", () => {
    it("says a switch is loading, and tells when it begins and fails", async () => {
      addYearOption("2024");
      let resolve!: (data: KMLDataset | null) => void;
      mockApp.dataManager.loadData.mockReturnValue(
        new Promise((done) => (resolve = done)),
      );
      const seen: boolean[] = [];
      filterManager.onLoadChange = () => seen.push(filterManager.loading);

      const switching = filterManager.filterByYear("2024");
      expect(filterManager.loading).toBe(true);
      resolve(null);
      await switching;

      expect(filterManager.loading).toBe(false);
      expect(seen).toEqual([true, false]);
    });

    it("is over when the dataset that ends it is published", async () => {
      addYearOption("2024");
      mockApp.dataManager.loadData.mockResolvedValue(year2024Data());
      const seen: boolean[] = [];
      mockApp.store.subscribe("currentData", () =>
        seen.push(filterManager.loading),
      );

      await filterManager.filterByYear("2024");

      expect(seen).toEqual([false]);
    });

    it("tells when a replay cancels the switch", () => {
      const onLoadChange = vi.fn();
      filterManager.onLoadChange = onLoadChange;

      filterManager.cancelPending();

      expect(onLoadChange).toHaveBeenCalledTimes(1);
      expect(filterManager.loading).toBe(false);
    });
  });

  describe("fitSelection", () => {
    const data = createDataset([
      { id: 840108108563, year: 2025 },
      { id: 7, year: 2025 },
    ]);

    it("keeps a selection the dataset knows untouched", () => {
      const selected = new Set([7, 840108108563]);
      mockApp.selectedPathIds = selected;
      mockApp.isolateSelection = true;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      fitSelection(asMapApp(mockApp), data);

      expect(mockApp.selectedPathIds).toBe(selected);
      expect([...selected]).toEqual([7, 840108108563]);
      expect(mockApp.isolateSelection).toBe(true);
      expect(listener).not.toHaveBeenCalled();
    });

    it("leaves out what a dataset of every year lacks, shared or not, and says so", () => {
      mockApp.selectedPathIds = new Set([3, 7, 12]);
      mockApp.isolateSelection = true;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      fitSelection(asMapApp(mockApp), data);

      expect([...mockApp.selectedPathIds]).toEqual([7]);
      expect(mockApp.isolateSelection).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "Left out 2 flights not on this site",
      );
    });

    it("turns share mode off when no selected id is left, in the same update", () => {
      mockApp.selectedPathIds = new Set([3]);
      mockApp.isolateSelection = true;
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () => {
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]);
      });

      fitSelection(asMapApp(mockApp), data);

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.isolateSelection).toBe(false);
      expect(seen).toEqual([[0, false]]);
    });

    it("keeps share mode where the filter draws none of the flights it shares", () => {
      // A link to flights of an aircraft that is named otherwise now: share
      // mode stays, and the chip says the filter hides them all
      mockApp.selectedPathIds = new Set([7, 840108108563]);
      mockApp.isolateSelection = true;
      mockApp.selectedAircraft = "D-EFGH";

      fitSelection(asMapApp(mockApp), data);

      expect(mockApp.isolateSelection).toBe(true);
      expect(mockApp.selectedPathIds.size).toBe(2);
    });

    it("deselects what the filter hides outside share mode, and says so", () => {
      mockApp.selectedPathIds = new Set([7, 840108108563]);
      mockApp.selectedAircraft = "D-EFGH";

      fitSelection(asMapApp(mockApp), data);

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "2 selected flights are hidden by the filter and were deselected",
      );
    });

    it("keeps a shared flight a dataset of one year lacks, which may be another year's", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds = new Set([7, 99]);
      mockApp.isolateSelection = true;

      fitSelection(asMapApp(mockApp), data);

      expect([...mockApp.selectedPathIds]).toEqual([7, 99]);
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("says a flight a dataset of one year lacks is not in that year, not that a filter hid it", () => {
      // A flight a re-export removed, or one of another year: one year's
      // file cannot tell, and a link's dead id was said to be filtered
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds = new Set([7, 99]);

      fitSelection(asMapApp(mockApp), data);

      expect([...mockApp.selectedPathIds]).toEqual([7]);
      expect(toastMock.showToast).toHaveBeenCalledExactlyOnceWith(
        "1 selected flight is not in 2025 and was deselected",
      );
    });

    it("keeps the ids when a year of the dataset failed to load", () => {
      mockApp.selectedPathIds = new Set([7, 99]);
      mockApp.isolateSelection = true;

      fitSelection(asMapApp(mockApp), { ...data, incomplete: true });

      expect([...mockApp.selectedPathIds]).toEqual([7, 99]);
      expect(mockApp.isolateSelection).toBe(true);
    });

    it("keeps share mode when a year failed to load, which may hold the flights", () => {
      mockApp.selectedPathIds = new Set([7, 99]);
      mockApp.isolateSelection = true;
      mockApp.selectedAircraft = "D-EFGH";

      fitSelection(asMapApp(mockApp), { ...data, incomplete: true });

      expect(mockApp.isolateSelection).toBe(true);
    });

    it("does nothing without a selection", () => {
      mockApp.isolateSelection = false;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      fitSelection(asMapApp(mockApp), data);

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
