/**
 * Cross-section - the heights flown along a line drawn on the map
 *
 * The heights of circuits, approaches and climb-outs are hard to judge in
 * a tilted 3D view. This tool draws a line on the map (two clicks or taps,
 * or a drag; the map centre by keyboard) and shows, side on, where time was
 * spent within a corridor either side of it: distance along the line
 * across, height up, as a density image weighed like the heatmap
 * (calculations/crossSection.ts). Heights are above the ground under each
 * fix by default, or above sea level with the terrain under the flights
 * drawn beneath them. The corridor is drawn on the map for as long as the
 * tool is open, and its two ends can be dragged, or moved with the arrow
 * keys, afterwards. The line is in the link and the saved state
 * (`crossSectionLine` of the store), and the tool opens on it as the page
 * does.
 *
 * It counts the flights the filters keep and, while flights are selected,
 * the selected ones among them, so a click on a flight shows that flight
 * alone. The panel is the one at the bottom of the map that the altitude
 * profile of a selected flight uses: the profile steps aside while this is
 * open (crossSectionOpen), and neither replay, Wrapped nor the hotspot
 * tour runs with it, as they take the map over: they close it.
 *
 * It comes with the feature bundle, which the Cross-section control
 * fetches the first time it is used (MapApp.toggleCrossSection). A closure
 * rather than a class: the bundle carries a class's member names as they
 * are written.
 *
 * This module holds the tool itself: its state, its panel, drawing a line
 * by pointer, drag and keyboard, the ends that move it afterwards, and
 * opening and closing. The corridor on the map (ui/crossSectionCorridor.ts),
 * the chart with its readout (ui/crossSectionChart.ts), what the two say in
 * words (ui/crossSectionText.ts) and the elements the panel is built of
 * (ui/crossSectionElements.ts) live next to it, all in the feature bundle.
 */
import {
  Marker,
  type GeoJSONSource,
  type Map as MapLibreMap,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import {
  CORRIDOR_HALF_WIDTHS_M,
  corridorForScale,
  crossSection,
  lineFrame,
  type CrossSection,
  type HeightReference,
  type LineFrame,
} from "../calculations/crossSection";
import { keptFlights } from "./keptFlights";
import { applyToggleButtonState } from "../utils/buttonState";
import { frameCoalescer } from "../utils/frameCoalescer";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  wrapDegrees,
  type Coordinate,
} from "../utils/geometry";
import { FIELDS, isPageEscape, toLngLat } from "../utils/mapHelpers";
import { isSectionLine } from "../state/urlState";
import { COLUMNS, createChart, ROWS } from "./crossSectionChart";
import {
  addLayers,
  CORRIDOR_SCREEN_PX,
  CROSS_SECTION_SOURCE,
  corridorData,
  pointAt,
  removeLayers,
  tooShort,
} from "./crossSectionCorridor";
import { button, element, select } from "./crossSectionElements";
import { focusModeControl } from "./heldControls";
import { featurePart } from "./lazyBundles";
import { sectionSummary, widthLabel } from "./crossSectionText";

/** The control in the View group that opens and closes the tool */
const CROSS_SECTION_BUTTON_ID = "cross-section-btn";

/** The panel's height, which the toasts stand on (features.css) */
export const CROSS_SECTION_HEIGHT_VAR = "--cross-section-h";

/** How far a pointer may move and still tap, in pixels */
const TAP_SLOP_PX = 6;

/** How far an arrow key moves an end of the line, in pixels; with Shift */
const KEY_STEP_PX = 10;
const KEY_STEP_FAST_PX = 50;

/** How long after the last key or drag the result is announced, in ms */
const ANNOUNCE_DELAY_MS = 600;

/** The tool of an app */
export interface CrossSectionTool {
  toggle(): void;
  isOpen(): boolean;
}

/** Who wants to hear the tool of each app open and close */
const followers = new WeakMap<MapApp, Set<() => void>>();

/** Whether the cross-section of `app` is open */
export function crossSectionOpen(app: MapApp): boolean {
  return featurePart(app, "crossSection")?.isOpen() ?? false;
}

/**
 * Call `listener` whenever the cross-section of `app` opens or closes, for
 * as long as `signal` lives: the profile strip steps aside for it
 */
export function followCrossSection(
  app: MapApp,
  listener: () => void,
  signal: AbortSignal,
): void {
  let listeners = followers.get(app);
  if (!listeners) followers.set(app, (listeners = new Set()));
  const own = listeners;
  own.add(listener);
  signal.addEventListener("abort", () => own.delete(listener), {
    once: true,
  });
}

/** Open the cross-section of `app`, or close it */
export function toggleCrossSection(app: MapApp): void {
  toolOf(app).toggle();
}

function toolOf(app: MapApp): CrossSectionTool {
  return featurePart(app, "crossSection", () => createTool(app));
}

/** Where the drawing of a line is */
type Phase = "closed" | "placing" | "shown";

/** A press on the map while a line is drawn */
interface Press {
  id: number;
  x: number;
  y: number;
  at: Coordinate;
  dragging: boolean;
}

function createTool(app: MapApp): CrossSectionTool {
  let phase: Phase = "closed";
  /** The line shown, [lat, lon] at each end */
  let line: [Coordinate, Coordinate] | null = null;
  /** The first end of a line being drawn */
  let first: Coordinate | null = null;
  let press: Press | null = null;
  /** The click that ends a press that placed a point goes to no flight */
  let swallowClick = false;
  /** The corridor's half width once picked, rather than from the zoom */
  let chosenWidth: number | null = null;
  let halfWidth: number = CORRIDOR_HALF_WIDTHS_M[1];
  let reference: HeightReference = "agl";
  let section: CrossSection | null = null;
  let frame: LineFrame | null = null;
  let frameRequest = 0;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Whether the map panned by dragging, and zoomed on a double click or
   * tap, as the tool started drawing
   */
  let panned = true;
  let zoomedOnDouble = true;

  // The panel
  const root = document.createElement("section");
  root.id = "cross-section";
  root.hidden = true;
  root.setAttribute("aria-labelledby", "cross-section-title");
  const bar = element("div", "section-bar", root);
  const title = element("h2", "section-title", bar);
  title.id = "cross-section-title";
  title.textContent = "Cross-section";
  const widthSelect = select(
    "Corridor either side of the line",
    CORRIDOR_HALF_WIDTHS_M.map((metres) => [
      String(metres),
      widthLabel(metres),
    ]),
    bar,
  );
  const referenceSelect = select(
    "Heights",
    [
      ["agl", "AGL"],
      ["msl", "MSL"],
    ],
    bar,
  );
  const redraw = button(
    "btn-surface section-btn",
    "Draw a new line",
    bar,
    "ruler",
  );
  const close = button(
    "btn-surface section-btn",
    "Close the cross-section",
    bar,
    "close",
  );
  const head = element("div", "profile-head", root);
  const stats = element("div", "profile-stats", head);
  const readout = element("div", "profile-readout", head);
  const place = element("div", "section-place", root);
  const hint = element("p", "section-hint", place);
  const placeButton = button("btn-surface section-place-btn", "", place);
  // The chart and its axis, between the place and the live region
  const { plot, axis, draw, paint, leave, readAt } = createChart(
    app,
    root,
    stats,
    readout,
  );
  const live = element("div", "visually-hidden", root);
  live.setAttribute("aria-live", "polite");

  /** The two ends on the map, A and B */
  const handles = (["A", "B"] as const).map((label, index) => {
    const handle = document.createElement("div");
    handle.className = "section-handle";
    handle.textContent = label;
    handle.tabIndex = 0;
    handle.setAttribute("role", "button");
    handle.setAttribute(
      "aria-label",
      `${index ? "End" : "Start"} of the cross-section, ${label}: drag it, or move it with the arrow keys`,
    );
    return new Marker({ element: handle, draggable: true });
  });

  const map = (): MapLibreMap | null => app.map;

  const notify = (): void => {
    for (const listener of followers.get(app) ?? []) listener();
  };

  /** Keep the control's pressed state and the page's class in step */
  const syncChrome = (): void => {
    // Asked first: a browser may let go of the focus of a part as it hides
    const active = document.activeElement;
    const open = phase !== "closed";
    root.hidden = !open;
    document.body.classList.toggle("cross-section-open", open);
    // The class draws the pressed look (see utils/buttonState.ts), which
    // aria-pressed alone left out
    const button = document.getElementById(CROSS_SECTION_BUTTON_ID);
    if (button) applyToggleButtonState(button, open);
    const placing = phase === "placing";
    place.hidden = !placing;
    plot.hidden = placing;
    axis.hidden = placing;
    redraw.hidden = placing;
    if (placing) {
      stats.textContent = "";
      readout.textContent = "";
      hint.textContent = first
        ? "Now B, the end of the line. Escape starts again."
        : "Click or tap two points on the map, or drag a line. Escape cancels.";
      placeButton.textContent = `Set ${first ? "B" : "A"} at the map centre`;
    }
    // Focus on a part that went away goes to the one in its place: the
    // button that placed B hands it to the one that draws a new line
    if (
      open &&
      active instanceof HTMLElement &&
      root.contains(active) &&
      active.closest("[hidden]")
    ) {
      (placing ? placeButton : redraw).focus({ preventScroll: true });
    }
  };

  // The corridor on the map

  /** Draw the corridor from `from` to `to`, or none */
  const drawCorridor = (from: Coordinate | null, to: Coordinate | null) => {
    const target = map();
    const source = target?.getSource<GeoJSONSource>(CROSS_SECTION_SOURCE);
    void source?.setData(corridorData(from, to, halfWidth));
  };

  /** Put the handles on the ends of the line, or take them off */
  const placeHandles = (): void => {
    const target = map();
    handles.forEach((handle, index) => {
      const at = phase === "shown" ? line?.[index] : index ? null : first;
      if (at && target) handle.setLngLat(toLngLat(at)).addTo(target);
      else handle.remove();
    });
  };

  /** The corridor for the map's zoom where none was picked */
  const widthForZoom = (at: Coordinate): number => {
    const zoom = map()?.getZoom() ?? 12;
    return corridorForScale(
      metresPerPixel(zoom) * Math.cos(at[0] * DEGREES_TO_RADIANS),
      CORRIDOR_SCREEN_PX,
    );
  };

  // The section and its chart

  /** Whether a flight counts: the filters keep it, and it is selected */
  const keeper = (): ((pathId: number) => boolean) | null => {
    const data = app.currentData;
    if (!data) return null;
    const selected = app.selectedPathIds;
    return keptFlights(app, data, selected.size ? selected : null);
  };

  /** Work the section out again and draw it */
  const compute = (): void => {
    const keep = keeper();
    const data = app.currentData;
    section =
      line && keep && data
        ? crossSection({
            segments: data.path_segments,
            keep,
            start: line[0],
            end: line[1],
            halfWidthM: halfWidth,
            reference,
            columns: COLUMNS,
            rows: ROWS,
          })
        : null;
    frame = line ? lineFrame(line[0], line[1]) : null;
    // For the link, to about a metre. An end the map gave past 180, on a
    // line across the antimeridian, is written in the world a link keeps to
    // (see isSectionLine); the line runs the short way round either way.
    app.crossSectionLine =
      line
        ?.flat()
        .map((degrees, i) =>
          (i % 2 && Math.abs(degrees) > 180
            ? wrapDegrees(degrees)
            : degrees
          ).toFixed(5),
        )
        .join(",") ?? "";
    draw(section);
  };

  /** Say what the chart shows once the line has come to rest */
  const announce = (): void => {
    if (announceTimer !== null) clearTimeout(announceTimer);
    announceTimer = null;
    live.textContent = section
      ? sectionSummary(section, app.selectedPathIds.size)
      : "";
  };

  const announceSoon = (): void => {
    if (announceTimer !== null) clearTimeout(announceTimer);
    announceTimer = setTimeout(announce, ANNOUNCE_DELAY_MS);
  };

  /** Draw the corridor and the chart of the line in the next frame */
  const schedule = (): void => {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      if (phase !== "shown") return;
      drawCorridor(line![0], line![1]);
      compute();
    });
  };

  // Drawing a line

  /**
   * Draw the corridor of the line being drawn to where the pointer of
   * `event` is, once a frame: the map's source is set anew for each, which
   * MapLibre hands to its worker, and a pointer moves many times a frame
   */
  const corridorFrame = frameCoalescer<PointerEvent>((event) => {
    const target = map();
    if (phase === "placing" && first && target) {
      drawCorridor(first, pointAt(target, event));
    }
  });

  /** Stop drawing: the map pans by dragging and zooms on a double again */
  const stopPlacing = (): void => {
    press = null;
    first = null;
    corridorFrame.cancel();
    const target = map();
    if (!target) return;
    target.getContainer().classList.remove("is-drawing-section");
    if (panned) target.dragPan.enable();
    if (zoomedOnDouble) target.doubleClickZoom.enable();
  };

  /** Show the line from `from` to `to`, if it is one */
  const finish = (from: Coordinate, to: Coordinate): void => {
    if (tooShort(from, to)) {
      live.textContent = "B is where A is: move the map, then set B";
      return;
    }
    stopPlacing();
    line = [from, to];
    if (chosenWidth === null) {
      halfWidth = widthForZoom(from);
      widthSelect.value = String(halfWidth);
    }
    phase = "shown";
    syncChrome();
    placeHandles();
    drawCorridor(from, to);
    compute();
    announce();
  };

  /** Start drawing a line; the one shown stays for Escape */
  const startPlacing = (): void => {
    const target = map();
    if (target && phase !== "placing") {
      panned = target.dragPan.isEnabled();
      target.dragPan.disable();
      // Two taps that place A and B would zoom the map in. The double tap
      // has no event to prevent (see keepMarkerTapsFromZoom), and switched
      // off, its recogniser does not see the second tap begin either.
      zoomedOnDouble = target.doubleClickZoom.isEnabled();
      target.doubleClickZoom.disable();
      target.getContainer().classList.add("is-drawing-section");
    }
    phase = "placing";
    first = null;
    press = null;
    if (chosenWidth === null && target) {
      halfWidth = widthForZoom([target.getCenter().lat, 0]);
      widthSelect.value = String(halfWidth);
    }
    syncChrome();
    placeHandles();
    drawCorridor(null, null);
    plot.removeAttribute("aria-label");
    leave();
  };

  /** Set a point of the line being drawn at `at` */
  const setPoint = (at: Coordinate): void => {
    if (!first) {
      first = at;
      syncChrome();
      placeHandles();
      return;
    }
    finish(first, at);
  };

  const onPointerDown = (event: PointerEvent): void => {
    // Whatever the press that placed a point left behind is done with: a
    // drag by touch, or one let go of beside the map, has no click to end
    // it, and the next click on the map is a flight's again
    swallowClick = false;
    const target = map();
    if (phase !== "placing" || !target) return;
    if (!event.isPrimary || event.button !== 0) {
      // A second finger: a pinch, not a line
      press = null;
      return;
    }
    if (!target.getCanvasContainer().contains(event.target as Node)) return;
    press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: pointAt(target, event),
      dragging: false,
    };
  };

  const onPointerMove = (event: PointerEvent): void => {
    const target = map();
    if (phase !== "placing" || !target) return;
    if (press && event.pointerId === press.id) {
      if (
        !press.dragging &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) >
          TAP_SLOP_PX
      ) {
        press.dragging = true;
        first = press.at;
        syncChrome();
        placeHandles();
      }
      if (press.dragging) corridorFrame.schedule(event);
    } else if (first && !press && event.pointerType === "mouse") {
      corridorFrame.schedule(event);
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    const target = map();
    const ended = press;
    if (phase !== "placing" || !target || !ended) return;
    if (event.pointerId !== ended.id) return;
    press = null;
    swallowClick = true;
    if (ended.dragging) finish(first!, pointAt(target, event));
    else setPoint(ended.at);
  };

  /** A click that placed a point selects no flight, nor opens a popup */
  const onClick = (event: MouseEvent): void => {
    const target = map();
    if (phase !== "placing" && !swallowClick) return;
    if (!target?.getCanvasContainer().contains(event.target as Node)) return;
    // The second click of a double one, which placed B, has its dblclick
    // still to come, and the map zooms in on that
    if (event.type === "dblclick" || event.detail < 2) swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    // An Escape in a popup or on an airport's marker closes the popup, one
    // in a text field or a select is the field's; one on an end of the line
    // is the tool's
    if (
      phase === "closed" ||
      !isPageEscape(event, ":not(.section-handle)" + FIELDS)
    ) {
      return;
    }
    event.preventDefault();
    if (phase === "placing" && (first || press)) {
      // Back to the start of the line being drawn
      startPlacing();
    } else if (phase === "placing" && line) {
      // Back to the line of before
      stopPlacing();
      phase = "shown";
      syncChrome();
      placeHandles();
      drawCorridor(line[0], line[1]);
      compute();
    } else {
      hide();
    }
  };

  /** Move an end of the line with the arrow keys */
  const onHandleKey = (index: number, event: KeyboardEvent): void => {
    const steps: Partial<Record<string, [number, number]>> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    const target = map();
    if (!step || !target || !line) return;
    // The map would pan by the same keys
    event.preventDefault();
    event.stopPropagation();
    const pixels = event.shiftKey ? KEY_STEP_FAST_PX : KEY_STEP_PX;
    const point = target.project(toLngLat(line[index]!));
    const moved = target.unproject([
      point.x + step[0] * pixels,
      point.y + step[1] * pixels,
    ]);
    // Onto the other end, there would be no line left: the key does nothing
    if (tooShort([moved.lat, moved.lng], line[1 - index]!)) return;
    line[index] = [moved.lat, moved.lng];
    handles[index]!.setLngLat([moved.lng, moved.lat]);
    schedule();
    announceSoon();
  };

  handles.forEach((handle, index) => {
    handle.on("drag", () => {
      if (phase !== "shown" || !line) return;
      const at = handle.getLngLat();
      const moved: Coordinate = [at.lat, at.lng];
      // On the other end the line keeps where this one was last apart
      if (tooShort(moved, line[1 - index]!)) return;
      line[index] = moved;
      schedule();
    });
    handle.on("dragend", () => {
      // An end let go of on the other goes back to where the line has it
      if (phase === "shown" && line) handle.setLngLat(toLngLat(line[index]!));
      announceSoon();
    });
    handle
      .getElement()
      .addEventListener("keydown", (event) => onHandleKey(index, event));
  });

  // Opening and closing

  /** The listeners of the tool on the map and the page, while it is open */
  let listening: AbortController | null = null;

  const listen = (target: MapLibreMap): void => {
    listening = new AbortController();
    const { signal } = listening;
    const container = target.getContainer();
    const capture = { capture: true, signal };
    container.addEventListener("pointerdown", onPointerDown, capture);
    // A drag may leave the map before it lets go
    window.addEventListener("pointermove", onPointerMove, capture);
    window.addEventListener("pointerup", onPointerUp, capture);
    window.addEventListener("pointercancel", () => (press = null), capture);
    // Clicks and double clicks as a point is placed: the map zoomed in on
    // the second of two quick clicks
    container.addEventListener("click", onClick, capture);
    container.addEventListener("dblclick", onClick, capture);
    // Last of all, on the window: what is open over the tool (the phone's
    // sheet) takes its Escape on the document and prevents it
    window.addEventListener("keydown", onKeyDown, { signal });
    // A new base style drops the corridor, which is none of the app's for
    // `withDataLayers` to carry
    const styled = target.on("styledata", () => {
      if (target.getSource(CROSS_SECTION_SOURCE)) return;
      addLayers(target);
      if (phase === "shown") drawCorridor(line![0], line![1]);
    });
    signal.addEventListener("abort", () => styled.unsubscribe(), {
      once: true,
    });
  };

  const show = (): void => {
    // Nor while the hotspot tour holds the map, which closes it as it
    // starts; its control is held then, and this covers a late bundle
    if (app.mapHeld || !map()) return;
    const target = map()!;
    const mapElement = document.getElementById("map");
    // Ahead of the map, in the <main> that holds it: after it, it was
    // past every airport marker in the tab order
    if (mapElement?.closest("main")) mapElement.before(root);
    else document.body.append(root);
    addLayers(target);
    listen(target);
    startPlacing();
    // The line of the link or of the last visit, as the page opens
    const saved = app.crossSectionLine;
    if (isSectionLine(saved)) {
      const [a, b, c, d] = saved.split(",").map(parseFloat) as [
        number,
        number,
        number,
        number,
      ];
      finish([a, b], [c, d]);
    }
    // One too short to show leaves the link and the saved state with it
    if (phase !== "shown") app.crossSectionLine = "";
    notify();
    // Into the part on show: on a line of the link, placing is over
    (phase === "placing" ? placeButton : redraw).focus({ preventScroll: true });
  };

  const hide = (): void => {
    if (phase === "closed") return;
    stopPlacing();
    phase = "closed";
    line = null;
    app.crossSectionLine = "";
    section = null;
    frame = null;
    if (frameRequest) cancelAnimationFrame(frameRequest);
    frameRequest = 0;
    if (announceTimer !== null) clearTimeout(announceTimer);
    announceTimer = null;
    listening?.abort();
    listening = null;
    const active = document.activeElement;
    const hadFocus =
      !!active &&
      (root.contains(active) ||
        handles.some((handle) => handle.getElement() === active));
    leave();
    placeHandles();
    const target = map();
    if (target) removeLayers(target);
    syncChrome();
    notify();
    if (hadFocus) focusModeControl(app, CROSS_SECTION_BUTTON_ID);
  };

  // The controls of the panel
  const lifetime = { signal: app.signal };
  placeButton.addEventListener(
    "click",
    () => {
      const center = map()?.getCenter();
      if (center) setPoint([center.lat, center.lng]);
    },
    lifetime,
  );
  redraw.addEventListener("click", startPlacing, lifetime);
  close.addEventListener("click", hide, lifetime);
  widthSelect.addEventListener(
    "change",
    () => {
      chosenWidth = halfWidth = Number(widthSelect.value);
      if (phase === "shown") {
        drawCorridor(line![0], line![1]);
        compute();
        announceSoon();
      }
    },
    lifetime,
  );
  referenceSelect.addEventListener(
    "change",
    () => {
      reference = referenceSelect.value === "msl" ? "msl" : "agl";
      compute();
      announceSoon();
    },
    lifetime,
  );
  plot.addEventListener(
    "pointermove",
    (event) => readAt(section, frame, event.clientX, event.clientY),
    lifetime,
  );
  plot.addEventListener(
    "pointerdown",
    (event) => {
      // A finger on the chart reads it rather than scrolling the page
      event.preventDefault();
      readAt(section, frame, event.clientX, event.clientY);
    },
    lifetime,
  );
  plot.addEventListener("pointerleave", leave, lifetime);
  plot.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerType !== "mouse") leave();
    },
    lifetime,
  );

  const resized =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          const height = root.offsetHeight;
          if (height > 0) {
            document.documentElement.style.setProperty(
              CROSS_SECTION_HEIGHT_VAR,
              `${height}px`,
            );
          }
          paint(section);
        });
  resized?.observe(root);
  resized?.observe(plot);

  const store = app.store;
  store.subscribeKeys(
    // The flights it counts
    ["currentData", "selectedYear", "selectedAircraft", "selectedPathIds"],
    () => {
      if (phase !== "shown") return;
      compute();
      announceSoon();
    },
  );
  // Replay and Wrapped take the map over
  store.subscribeKeys(["replayActive", "wrappedVisible"], () => {
    if (app.replayActive || app.wrappedVisible) hide();
  });
  app.signal.addEventListener(
    "abort",
    () => {
      hide();
      resized?.disconnect();
      root.remove();
    },
    { once: true },
  );

  return {
    isOpen: () => phase !== "closed",
    toggle: () => (phase === "closed" ? show() : hide()),
  };
}
