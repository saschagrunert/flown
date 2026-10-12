/**
 * LayerManager: a click on a flight, the pointer over a marker or over
 * tiles that cannot answer yet, the Wrapped dialog's overview, and
 * destroy. The tooltip of a hover is in pathHover.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LngLat } from "maplibre-gl";
import type { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import type { PathSegment } from "../../../../flown/frontend/types";
import type { MockApp } from "../../testHelpers";
import {
  ALTITUDE,
  drawMode,
  layerManagerHelpers,
  setupLayerManager,
  teardownLayerManager,
} from "./layerManagerTestSetup";

// The shared fake with one addition: the popups the code under test made
const popups = vi.hoisted((): unknown[] => []);
vi.mock("maplibre-gl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../mocks/maplibre-gl")>();
  class Popup extends actual.Popup {
    constructor(options: Record<string, unknown> = {}) {
      super(options);
      popups.push(this);
    }
  }
  return { ...actual, Popup, default: { ...actual.default, Popup } };
});

describe("LayerManager pointer", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;
  const {
    addSecondPath,
    runFrames,
    landed,
    holdSetData,
    rendered,
    pointAt,
    moveTo,
    tooltips,
  } = layerManagerHelpers({
    get layerManager() {
      return layerManager;
    },
    get mockApp() {
      return mockApp;
    },
    get frames() {
      return frames;
    },
    popups,
  });

  beforeEach(() => {
    popups.length = 0;
    ({ layerManager, mockApp, frames } = setupLayerManager());
  });

  afterEach(() => teardownLayerManager(layerManager));

  describe("onPathClick", () => {
    function hitOf(segment: PathSegment) {
      return { pathId: segment.path_id, segment };
    }

    /** The button under the values of the popup of a tap, if any */
    const action = (index = 0): HTMLButtonElement | null =>
      tooltips()[index]!.getElement().querySelector(".segment-action");

    it("opens a popup with the segment's values on touch and leaves the selection alone", () => {
      const lngLat = mockApp.map!.unproject([10, 10]) as LngLat;

      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        lngLat,
        true,
      );

      expect(tooltips()).toHaveLength(1);
      const popup = tooltips()[0]!;
      // Not the tooltip's class, which takes no pointer events: this one
      // has a close button, and a tap through it would hit the flight below
      expect(popup.options).toMatchObject({
        className: "segment-details segment-popup",
        // MapLibre would close it on a click the dispatcher ignores as well
        closeOnClick: false,
      });
      expect(String(popup.options["className"])).not.toContain(
        "segment-tooltip",
      );
      expect(popup.trackPointer).not.toHaveBeenCalled();
      expect(popup.getLngLat()).toEqual(lngLat);
      expect(popup.isOpen()).toBe(true);
      expect(popup.getElement().innerHTML).toContain("3,000 ft");
      // Looking at a flight on a phone selected it, and a second look
      // took it out again
      expect(mockApp.pathSelection.togglePathSelection).not.toHaveBeenCalled();
    });

    it("selects the flight of a tap with its button, which closes the values", () => {
      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
        true,
      );
      const button = action()!;
      expect(button.textContent).toBe("Select flight");
      expect(button.type).toBe("button");

      button.click();

      expect(
        mockApp.pathSelection.togglePathSelection,
      ).toHaveBeenCalledExactlyOnceWith(1);
      expect(tooltips()[0]!.isOpen()).toBe(false);
    });

    it("offers to take a selected flight out", () => {
      mockApp.selectedPathIds = new Set([1]);

      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
        true,
      );

      expect(action()!.textContent).toBe("Remove flight");
    });

    it("shows a mouse the values with a Remove in share mode, where the selection holds still", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.isolateSelection = true;

      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
      );

      // A click on a shared flight took it out, and it vanished
      expect(mockApp.pathSelection.togglePathSelection).not.toHaveBeenCalled();
      expect(tooltips()[0]!.isOpen()).toBe(true);
      expect(action()!.textContent).toBe("Remove flight");
    });

    it("shows a tap the values without a button during the hotspot tour", () => {
      (mockApp as { tourView: unknown }).tourView = {};

      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
        true,
      );

      // The tour holds the selection, and Select did nothing
      expect(tooltips()[0]!.isOpen()).toBe(true);
      expect(action()!.hidden).toBe(true);
    });

    it("has the stylesheet hide a hidden button, whose display: block beat the browser's rule", () => {
      // An empty blue bar stayed during the tour, and a stale Select that
      // only closed the values. jsdom lets [hidden] win whatever the
      // stylesheet says, so the rule itself is looked for.
      const style = document.createElement("style");
      style.textContent = readFileSync("flown/static/styles.css", "utf8");
      document.head.append(style);
      try {
        const hides = [...style.sheet!.cssRules].some(
          (rule) =>
            rule instanceof CSSStyleRule &&
            rule.selectorText
              .split(",")
              .some(
                (selector) => selector.trim() === ".segment-action[hidden]",
              ) &&
            rule.style.display === "none",
        );
        expect(hides).toBe(true);
      } finally {
        style.remove();
      }
    });

    it("labels the button for the selection as it is now", () => {
      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
        true,
      );
      expect(action()!.textContent).toBe("Select flight");

      // Ticked in a list meanwhile: "Select flight" took it out
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      expect(action()!.textContent).toBe("Remove flight");

      // A replay holds the selection, and the button did nothing
      mockApp.replayActive = true;
      expect(action()!.hidden).toBe(true);
      mockApp.replayActive = false;
      expect(action()!.hidden).toBe(false);

      action()!.click();
      expect(
        mockApp.pathSelection.togglePathSelection,
      ).toHaveBeenCalledExactlyOnceWith(1);
    });

    it("puts the values of a tap away as a mouse toggles a flight", () => {
      const at = mockApp.map!.unproject([10, 10]) as LngLat;
      const hit = hitOf(mockApp.currentData!.path_segments[0]!);
      layerManager.onPathClick(hit, at, true);

      layerManager.onPathClick(hit, at);

      // They said what the flight was before the click
      expect(tooltips()[0]!.isOpen()).toBe(false);
      expect(mockApp.pathSelection.togglePathSelection).toHaveBeenCalledWith(1);
    });

    it("closes the popup of a tap once the globe has turned its place away", () => {
      mockApp.map!.setProjection({ type: "globe" });
      const lngLat = mockApp.map!.unproject([10, 10]) as LngLat;
      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        lngLat,
        true,
      );
      const popup = tooltips()[0]!;

      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(true);

      // MapLibre would leave it open over whatever is drawn there now
      mockApp.map!.jumpTo({ center: [lngLat.lng + 170, lngLat.lat] });
      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(false);
    });

    it("replaces the popup of the tap before", () => {
      const lngLat = mockApp.map!.unproject([10, 10]) as LngLat;
      const hit = hitOf(mockApp.currentData!.path_segments[0]!);

      layerManager.onPathClick(hit, lngLat, true);
      layerManager.onPathClick(hit, lngLat, true);

      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, true]);
    });

    it("opens no popup on a click with a mouse but toggles the selection", () => {
      layerManager.onPathClick(
        hitOf(mockApp.currentData!.path_segments[0]!),
        mockApp.map!.unproject([10, 10]) as LngLat,
      );

      expect(tooltips()).toHaveLength(0);
      expect(mockApp.pathSelection.togglePathSelection).toHaveBeenCalledWith(1);
    });
  });

  describe("a pointer over a marker", () => {
    function onMarker(): Event {
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      const label = document.createElement("span");
      marker.append(label);
      mockApp.map!.getCanvasContainer().append(marker);
      const event = new MouseEvent("mousemove", { bubbles: true });
      // What the map reports is aimed at whatever is inside the marker
      label.dispatchEvent(event);
      return event;
    }

    beforeEach(() => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
    });

    it("closes the hover's tooltip and leaves the values of a tap open", () => {
      moveTo(pointAt(48.5, 16.5));
      // Another flight's: the tooltip of the tapped one steps aside
      addSecondPath();
      layerManager.onPathClick(
        { pathId: 2, segment: mockApp.currentData!.path_segments.at(-1)! },
        mockApp.map!.unproject([10, 10]) as LngLat,
        true,
      );
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([true, true]);

      // The flight runs on below the marker, so the same point would hit
      mockApp.map!.emit("mousemove", {
        point: pointAt(48.5, 16.5),
        originalEvent: onMarker(),
      });
      runFrames();

      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, true]);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");
    });

    it("keeps the tooltip of a flight away while a click holds its values open", () => {
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([true]);

      // Share mode shows a mouse the values with Remove, which the
      // tooltip of the same flight covered
      mockApp.isolateSelection = true;
      layerManager.onPathClick(
        { pathId: 1, segment: mockApp.currentData!.path_segments[0]! },
        mockApp.map!.unproject([10, 10]) as LngLat,
      );
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, true]);
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()[0]!.isOpen()).toBe(false);

      // Back once the values are closed
      tooltips()[1]!.remove();
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()[0]!.isOpen()).toBe(true);
    });

    describe("once the map has moved under a pointer that rests", () => {
      /** What the document finds under the pointer from now on */
      function under(element: Element | null): void {
        (
          document as { elementFromPoint?: (x: number, y: number) => unknown }
        ).elementFromPoint = vi.fn(() => element);
      }

      afterEach(() => {
        // jsdom has none of its own
        delete (document as { elementFromPoint?: unknown }).elementFromPoint;
      });

      it("shows the flight a zoom has brought out from under the marker", () => {
        const originalEvent = onMarker();
        mockApp.map!.emit("mousemove", {
          point: pointAt(48.5, 16.5),
          originalEvent,
        });
        runFrames();
        expect(tooltips()).toHaveLength(0);

        // The marker has moved away; the event still names it
        under(mockApp.map!.getCanvas());
        drawMode(layerManager, "altitude");
        mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
        mockApp.map!.emit("idle");

        expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
      });

      it("closes the tooltip a zoom has slid a marker under", () => {
        const onCanvas = new MouseEvent("mousemove", { bubbles: true });
        mockApp.map!.getCanvas().dispatchEvent(onCanvas);
        mockApp.map!.emit("mousemove", {
          point: pointAt(48.5, 16.5),
          originalEvent: onCanvas,
        });
        runFrames();
        expect(tooltips()[0]!.isOpen()).toBe(true);

        under((onMarker().target as Element).closest(".maplibregl-marker"));
        drawMode(layerManager, "altitude");
        mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
        mockApp.map!.emit("idle");

        expect(tooltips()[0]!.isOpen()).toBe(false);
      });
    });

    it("stands down a hover that was already waiting for its frame", () => {
      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });

      mockApp.map!.emit("mousemove", {
        point: pointAt(48.5, 16.5),
        originalEvent: onMarker(),
      });
      runFrames();

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(0);
    });
  });

  describe("a hover the tiles cannot answer yet", () => {
    beforeEach(async () => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      await landed();
    });

    it("looks again on idle, also when the pointer came after the redraw", async () => {
      // The pointer is off the map, so the redraw asks for no look on idle
      const workerAnswers = holdSetData(ALTITUDE);
      drawMode(layerManager, "altitude");
      expect(mockApp.map!.listenerCount("idle")).toBe(0);

      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()).toHaveLength(0);
      expect(mockApp.map!.listenerCount("idle")).toBe(1);

      await workerAnswers();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
      mockApp.map!.emit("idle");

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
    });

    it("keeps the tooltip over a flight of the tiles of before, and only there", () => {
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips()[0]!.isOpen()).toBe(true);
      holdSetData(ALTITUDE);
      drawMode(layerManager, "altitude");

      // The flight may well still be there
      moveTo(pointAt(48.51, 16.51));
      expect(tooltips()[0]!.isOpen()).toBe(true);

      // Over nothing at all there is nothing to go on showing
      mockApp.map!.renderedFeatures = [];
      moveTo(pointAt(40, 10));
      expect(tooltips()[0]!.isOpen()).toBe(false);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");
    });

    it("does not take a zoom for one: the tooltip closes beside the flight at once", () => {
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.5, 16.5));
      // Tiles are loading, as during every wheel zoom
      mockApp.map!.isSourceLoaded.mockReturnValue(false);
      mockApp.map!.renderedFeatures = [];

      moveTo(pointAt(40, 10));

      expect(tooltips()[0]!.isOpen()).toBe(false);
    });
  });

  describe("while the Wrapped dialog shows the map as its overview", () => {
    beforeEach(() => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
    });

    it("shows no tooltip for a flight under the pointer", () => {
      mockApp.store.set("wrappedVisible", true);

      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });
      // Not even a frame that would find nothing to do
      expect(frames.size).toBe(0);
      moveTo(pointAt(48.5, 16.5));

      expect(tooltips()).toHaveLength(0);
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();

      mockApp.store.set("wrappedVisible", false);
      moveTo(pointAt(48.5, 16.5));
      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(1);
    });

    it("does not bring the tooltip back when the data is drawn again", () => {
      // The pointer rests where it was when the dialog opened
      moveTo(pointAt(48.5, 16.5));
      mockApp.store.set("wrappedVisible", true);
      layerManager.closeSegmentPopup();

      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
      mockApp.map!.emit("idle");

      expect(tooltips().filter((popup) => popup.isOpen())).toHaveLength(0);
    });
  });

  describe("destroy", () => {
    it("listens to the pointer once per map", () => {
      expect(mockApp.map!.listenerCount("mousemove")).toBe(1);
      expect(mockApp.map!.listenerCount("mouseout")).toBe(1);
    });

    it("removes the listeners, the popups and the pending frame", () => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.5, 16.5));
      // Another flight's: the tooltip of the tapped one steps aside
      addSecondPath();
      layerManager.onPathClick(
        { pathId: 2, segment: mockApp.currentData!.path_segments.at(-1)! },
        mockApp.map!.unproject([10, 10]) as LngLat,
        true,
      );
      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });
      expect(frames.size).toBe(1);
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([true, true]);

      layerManager.destroy();

      expect(mockApp.map!.listenerCount("mousemove")).toBe(0);
      expect(mockApp.map!.listenerCount("mouseout")).toBe(0);
      expect(cancelAnimationFrame).toHaveBeenCalledOnce();
      expect(frames.size).toBe(0);
      expect(tooltips().map((popup) => popup.isOpen())).toEqual([false, false]);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");
    });

    it("ignores an idle that arrives afterwards", () => {
      mockApp.altitudeLayer.setVisible(true);
      mockApp.altitudeVisible = true;
      drawMode(layerManager, "altitude");
      mockApp.map!.emit("mousemove", { point: pointAt(48.5, 16.5) });
      layerManager.updateSelectionStyles();
      mockApp.map!.queryRenderedFeatures.mockClear();

      layerManager.destroy();
      mockApp.map!.emit("idle");

      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();
    });
  });
});
