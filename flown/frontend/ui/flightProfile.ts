/**
 * Flight profile - the altitude of the selected flights, over the ground
 *
 * With a flight selected, a strip at the bottom of the map draws its
 * altitude against its time (against the distance flown for a flight
 * without times), with the ground filled in underneath and a row of
 * figures: the highest altitude, the lowest height above the ground en
 * route and the time spent low (calculations/flightProfile.ts). Its data is
 * all in the browser already: the flight's segments, sliced out of the
 * dataset.
 *
 * With two to DAY_MAX_FLIGHTS selected, say the flights of a day, it
 * draws them one after another in the order of their files (flightOrder),
 * each named by its route over its part of the chart, with a narrow gap
 * between them rather than the time on the ground (joinProfiles); the
 * readout gives the time into the flight pointed at, and a click opens the
 * replay of them one after another there, on one clock. More than that
 * have no profile.
 *
 * Pointing at the chart reads out the values there and marks the place on
 * the map; pointing at the flight on the map moves the chart's cursor
 * (ui/pathHover.ts). A click or a drag on a flight with times opens replay
 * paused at that moment; on touch a finger reads and a tap opens it. While
 * replay runs the strip is part of its panel and its scrubber: its cursor
 * follows the replay's time, a drag seeks, and the plain slider stays
 * underneath for the keyboard. The replay of every flight at once is not
 * of this one: the strip and its toggle stay away while it runs, and its
 * panel stays its own. So do they while the cross-section, which takes the
 * same place at the bottom of the map, is open (ui/crossSection.ts).
 *
 * Whether it shows is remembered in the browser, and the selection chip
 * carries the toggle. It comes with the feature bundle, which the app
 * fetches as a flight is first selected (MapApp.followFlightProfile).
 * A closure rather than a class: the bundle carries a class's member names
 * as they are written.
 */
import { Marker } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { KMLDataset, PathSegment } from "../types";
import type { ReplayManager } from "./replayManager";
import type { ReplayState } from "./replayState";
import { segmentsForPathIds } from "../calculations/statistics";
import { shownSelection } from "../calculations/datasetIndex";
import {
  flightOrder,
  flightProfile,
  joinProfiles,
  locate,
  snapToLegs,
  valueAt,
  LOW_HEIGHT_FT,
  type FlightProfile,
  type ProfileLeg,
  type ProfilePoint,
} from "../calculations/flightProfile";
import { datasetIndex } from "../calculations/datasetIndex";
import { flightRoute } from "./airportFlights";
import { airplaneLiftPx } from "../calculations/airplaneLift";
import { liftExaggeration } from "../calculations/lift";
import { legAt, prepareReplaySegments } from "../features/replay";
import { siteData } from "../state/siteData";
import { domCache } from "../utils/domCache";
import { formatDuration } from "../utils/duration";
import { formatNumber } from "../utils/formatters";
import { DAY_MAX_FLIGHTS } from "../utils/constants";
import { pluralFlights } from "../utils/htmlGenerators";
import { formatSpeed, formatTime } from "../utils/replayFormatters";
import type { Coordinate } from "../utils/geometry";
import { setControlIcon } from "../utils/icons";
import { toLngLat } from "../utils/mapHelpers";
import { storedFlag, storeFlag } from "../utils/storedFlag";
import { showToast } from "../utils/toast";
import { crossSectionOpen, followCrossSection } from "./crossSection";
import { heldReason } from "./heldControls";
import { element, shape } from "./crossSectionElements";
import { heightUnit } from "./crossSectionText";

/** The chart's own units: it is stretched to the strip (see the CSS) */
const VIEW_W = 1000;
const VIEW_H = 100;

/**
 * Share of the chart's height kept free above the highest point, and with
 * several flights, for their routes over them
 */
const HEADROOM = 0.12;
const LEGS_HEADROOM = 0.3;

/** Whether the strip was put away, kept in the browser like a panel's */
export const PROFILE_STORAGE_KEY = "flown-profile-collapsed";

/** The strip's height, which the toasts stand on (features.css) */
export const PROFILE_HEIGHT_VAR = "--flight-profile-h";

/** Said for a click on a flight of the profile that has no replay */
export const NO_TIMES_MESSAGE = "No timing data for this flight";

/** How far a finger may move and still tap, in pixels */
const TAP_SLOP_PX = 6;

/** The segments of the flight `pathId` the profile runs along */
export function profileSegments(
  data: KMLDataset,
  pathId: number,
): PathSegment[] {
  // The replay's own, where it can replay the flight: the scrubber maps
  // its points to the replay's one by one
  const timed = prepareReplaySegments(data.path_segments, pathId);
  if ((timed[timed.length - 1]?.time ?? 0) > 0) return timed;
  return segmentsForPathIds(data.path_segments, [pathId]);
}

/** The time or distance into the flight, as the readout and axis say it */
function formatX(profile: FlightProfile, value: number): string {
  const x = profile.x;
  const span = x[x.length - 1]! - x[0]!;
  return profile.timed
    ? formatTime(value - x[0]!, span)
    : formatNumber(value, span < 10 ? 1 : 0) + " km";
}

/** A drag on the chart, from the press to the release */
interface Drag {
  startX: number;
  moved: boolean;
  /** A mouse seeks as it drags; a finger reads, and a tap seeks */
  mouse: boolean;
}

/**
 * Show the profile of the selected flights from now on, for as long as the
 * app lives. Returns the strip.
 */
export function followFlightProfile(app: MapApp): HTMLElement {
  const lifetime = { signal: app.signal };

  const root = document.createElement("section");
  root.id = "flight-profile";
  root.hidden = true;
  root.setAttribute("aria-label", "Altitude profile");
  const head = element("div", "profile-head", root);
  const stats = element("div", "profile-stats", head);
  const readout = element("div", "profile-readout", head);
  const plot = element("div", "profile-plot", root);
  plot.setAttribute("role", "img");
  const svg = shape("svg", "profile-chart", plot);
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const ground = shape("path", "profile-ground", svg);
  const line = shape("path", "profile-line", svg);
  const replayCursor = shape("line", "profile-cursor", svg);
  const hoverCursor = shape("line", "profile-hover", svg);
  for (const cursor of [replayCursor, hoverCursor]) {
    cursor.setAttribute("y2", String(VIEW_H));
    cursor.setAttribute("visibility", "hidden");
  }
  // The routes of the flights one after another, over the chart
  const routes = element("div", "profile-legs", plot);
  routes.setAttribute("aria-hidden", "true");
  const dot = element("span", "profile-dot", plot);
  dot.hidden = true;
  const axis = element("div", "profile-axis", root);
  axis.setAttribute("aria-hidden", "true");
  const axisStart = element("span", "", axis);
  const axisEnd = element("span", "", axis);
  document.body.append(root);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.id = "profile-toggle-btn";
  toggle.className = "profile-toggle";
  toggle.setAttribute("aria-controls", root.id);
  toggle.setAttribute("aria-label", "Altitude profile");
  setControlIcon(toggle, "altitude", 16);
  domCache
    .get("selection-chip")
    ?.insertBefore(toggle, domCache.get("selection-clear-btn"));

  let profile: FlightProfile | null = null;
  /**
   * The flights selected as it was drawn, the dataset, and the flights
   * drawn, in their order
   */
  let drawnFor = "";
  let data: KMLDataset | null = null;
  let pathIds: number[] = [];
  /** The flights of a profile of several, none for one (joinProfiles) */
  let legs: ProfileLeg[] = [];
  let collapsed = storedFlag(PROFILE_STORAGE_KEY);
  let drag: Drag | null = null;
  /** The place on the map the pointer on the chart stands for */
  let marker: Marker | null = null;
  /** The chart's range: its first and last x, lowest and highest feet */
  let x0 = 0;
  let x1 = 1;
  let y0 = 0;
  let y1 = 1;

  /** Whether the replay of every flight runs (ui/replayAll.ts) */
  const replayingAll = (): boolean => app.replayActive && app.replayState.all;
  /** Whether the replay of one flight runs, whose panel takes the strip */
  const replaying = (): boolean => app.replayActive && !app.replayState.all;
  /** Where a value of x is across the chart, in its own units */
  const chartX = (value: number): number =>
    x1 > x0 ? ((value - x0) / (x1 - x0)) * VIEW_W : 0;
  /** The value of a column of the profile at a point */
  const at = (values: Float64Array, point: ProfilePoint): number =>
    valueAt((i) => values[i]!, values.length, point);
  /** The point of the profile at a value of x */
  const locateX = (value: number): ProfilePoint => {
    const x = profile!.x;
    return locate(x.length, (i) => x[i]!, value);
  };
  /**
   * The point of the profile under a pointer at `clientX`: in a gap
   * between two flights, the nearer end of one
   */
  const pointAt = (clientX: number): ProfilePoint => {
    const box = plot.getBoundingClientRect();
    const share =
      box.width > 0
        ? Math.min(1, Math.max(0, (clientX - box.left) / box.width))
        : 0;
    const value = x0 + share * (x1 - x0);
    return locateX(legs.length ? snapToLegs(profile!.x, legs, value) : value);
  };
  /** Whether the flight at `point` has times, and a click there replays it */
  const timedAt = (point: ProfilePoint): boolean =>
    !!(legs.find(({ last }) => point.index <= last) ?? profile)?.timed;
  const setCursor = (cursor: SVGElement, point: ProfilePoint | null): void => {
    if (point) {
      const x = chartX(at(profile!.x, point)).toFixed(1);
      cursor.setAttribute("x1", x);
      cursor.setAttribute("x2", x);
    }
    cursor.setAttribute("visibility", point ? "visible" : "hidden");
  };

  /** Nothing is pointed at: the pointer left, or the strip went */
  const leave = (): void => {
    if (drag) return;
    setCursor(hoverCursor, null);
    dot.hidden = true;
    readout.textContent = "";
    marker?.remove();
  };

  /**
   * Point at `point`: the cursor, the values there and, with `onMap`, the
   * place on the map
   */
  const showPoint = (point: ProfilePoint, onMap: boolean): void => {
    const shown = profile!;
    setCursor(hoverCursor, point);
    const altitude = at(shown.altitudeFt, point);
    const heightFt = altitude - at(shown.groundFt, point);
    const x = at(shown.x, point);
    dot.style.left = `${chartX(x) / (VIEW_W / 100)}%`;
    dot.style.top = `${((y1 - altitude) / (y1 - y0)) * 100}%`;
    dot.hidden = false;
    const segment = shown.segments[point.index]!;
    const speed = segment.groundspeed_knots;
    // Between two fixes the values are the line's, to the nearest 10 ft
    const tens = (feet: number): string =>
      formatNumber(Math.round(Math.max(0, feet) / 10) * 10);
    // Of several flights, the time or the distance into the one there
    const leg = legs.find(({ last }) => point.index <= last);
    readout.textContent = [
      `${tens(altitude)} ft`,
      tens(heightFt) + " " + heightUnit(shown),
      ...(speed > 0 ? [formatSpeed(speed)] : []),
      formatX(shown, leg ? x - shown.x[leg.first]! + x0 : x),
    ].join(" · ");
    const map = app.map;
    if (!onMap || !map) {
      marker?.remove();
      return;
    }
    const [[lat1, lon1], [lat2, lon2]] = segment.coords;
    const { fraction } = point;
    const lat = lat1 + (lat2 - lat1) * fraction;
    marker ??= new Marker({
      element: Object.assign(document.createElement("div"), {
        className: "profile-map-dot",
      }),
    });
    // In the 3D view the flight is drawn at its height, and so is the dot
    const lift = app.threeDVisible
      ? airplaneLiftPx(map, lat, heightFt, liftExaggeration(app.reliefLevel))
      : 0;
    marker
      .setLngLat(toLngLat([lat, lon1 + (lon2 - lon1) * fraction]))
      .setOffset([0, -lift]);
    // Put on the map once and moved after that: MapLibre takes a marker
    // off the map and puts it on again for every addTo, which was at every
    // move of a pointer or a finger over the chart
    if (!marker.getElement().parentNode) marker.addTo(map);
  };

  /** Draw the chart and the figures of the profile */
  const draw = (): void => {
    leave();
    setCursor(replayCursor, null);
    if (!profile) return;
    const { x, altitudeFt, groundFt } = profile;
    const count = x.length;
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < count; i++) {
      low = Math.min(low, groundFt[i]!, altitudeFt[i]!);
      high = Math.max(high, groundFt[i]!, altitudeFt[i]!);
    }
    x0 = x[0]!;
    x1 = x[count - 1]!;
    y0 = low;
    y1 =
      low +
      Math.max(high - low, 100) *
        (1 + (legs.length ? LEGS_HEADROOM : HEADROOM));
    const xOf = (i: number): string => chartX(x[i]!).toFixed(1);
    const yOf = (feet: number): string =>
      (VIEW_H - ((feet - y0) / (y1 - y0)) * VIEW_H).toFixed(1);
    // Each flight of several on its own, with nothing across the gaps
    let path = "";
    let floor = "";
    routes.replaceChildren();
    const names: string[] = [];
    const runs = legs.length ? legs : [{ first: 0, last: count - 1 }];
    runs.forEach(({ first, last }, k) => {
      floor += `M${xOf(first)} ${VIEW_H}`;
      for (let i = first; i <= last; i++) {
        path += `${i > first ? "L" : "M"}${xOf(i)} ${yOf(altitudeFt[i]!)}`;
        floor += `L${xOf(i)} ${yOf(groundFt[i]!)}`;
      }
      floor += `L${xOf(last)} ${VIEW_H}Z`;
      if (!legs.length) return;
      // Its route over it, from the middle of the gap before it to the
      // middle of the one after, the gaps marked by its edges
      const from = k ? (x[runs[k - 1]!.last]! + x[first]!) / 2 : x0;
      const to = runs[k + 1] ? (x[last]! + x[runs[k + 1]!.first]!) / 2 : x1;
      const route = element("span", "profile-leg", routes);
      route.style.left = `${chartX(from) / (VIEW_W / 100)}%`;
      route.style.width = `${(chartX(to) - chartX(from)) / (VIEW_W / 100)}%`;
      route.textContent = flightRoute(
        datasetIndex(data!).pathInfoById.get(pathIds[k]!)!,
      );
      names.push(route.textContent);
    });
    line.setAttribute("d", path);
    ground.setAttribute("d", floor);

    const unit = " " + heightUnit(profile);
    // Above sea level, where the lowest is above the ground: said so
    const highest = `${formatNumber(profile.maxAltitudeFt)} ft MSL`;
    const lowest = profile.lowestEnRouteFt;
    const figures = [
      ["Highest", highest],
      ["Lowest en route", lowest === null ? "—" : formatNumber(lowest) + unit],
    ];
    if (profile.lowSeconds !== null) {
      figures.push([
        `Below ${formatNumber(LOW_HEIGHT_FT)}${unit}`,
        formatDuration(profile.lowSeconds),
      ]);
    }
    stats.replaceChildren();
    for (const [label, value] of figures) {
      const stat = element("span", "profile-stat", stats);
      element("span", "profile-stat-label", stat).textContent = label!;
      stat.append(" ", value!);
    }
    const start = formatX(profile, x0);
    // Several flights end with how many, the gaps between them being no
    // time or distance of theirs
    const end = legs.length ? pluralFlights(legs.length) : formatX(profile, x1);
    axisStart.textContent = start;
    axisEnd.textContent = end;
    // The routes over the chart are hidden from a screen reader, which
    // hears them here, in their order
    plot.setAttribute(
      "aria-label",
      `Altitude over ${profile.timed ? "time" : "distance"}, ${legs.length ? `${end}: ${names.join(", ")}` : `${start} to ${end}`}, highest ${highest}`,
    );
  };

  /** Show or hide the strip and its toggle, and put the panel in step */
  const sync = (): void => {
    // The replay of all flights and the cross-section have the place
    const away = replayingAll() || crossSectionOpen(app);
    const shown = !!profile && !collapsed && !app.wrappedVisible && !away;
    const replay = replaying();
    root.hidden = !shown;
    // A click opens the replay of a flight with times; of several, as
    // the pointer moves over theirs (see the pointermove below)
    root.classList.toggle("is-timed", !!profile?.timed);
    toggle.hidden = !profile || away;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = `${collapsed ? "Show" : "Hide"} the altitude profile`;
    document.body.classList.toggle("profile-open", shown && !replay);
    // The panel follows its own height, the strip's in it included (see
    // followPanelHeight)
    if (replay) {
      domCache.get("replay-controls")?.classList.toggle("has-profile", shown);
    }
    if (!shown) leave();
  };

  /**
   * Build the profile again when the flights or the dataset changed: the
   * selected flights the filter shows, as Replay plays them
   * (MapApp.canReplay); share mode keeps the ones a filter hides
   */
  const refresh = (): void => {
    const current = app.currentData;
    const selected = shownSelection(app);
    const ids =
      current && selected.size <= DAY_MAX_FLIGHTS
        ? flightOrder(current.path_info, selected)
        : [];
    if (ids.join() !== drawnFor || current !== data) {
      drawnFor = ids.join();
      data = current;
      const byId = current && datasetIndex(current).pathInfoById;
      const fields = (siteData.airports ?? []).map((airport): Coordinate => [
        airport.lat,
        airport.lon,
      ]);
      // A flight of fewer than two segments has none, and is left out
      const parts = ids.flatMap((id) => {
        const part = flightProfile(
          profileSegments(current!, id),
          fields,
          byId!.get(id)?.max_altitude_ft,
        );
        return part ? [{ id, part }] : [];
      });
      pathIds = parts.map(({ id }) => id);
      const joined =
        parts.length > 1 ? joinProfiles(parts.map(({ part }) => part)) : null;
      legs = joined?.legs ?? [];
      profile = joined ?? parts[0]?.part ?? null;
      draw();
    }
    sync();
  };

  /**
   * The flight `k` of the profile in the replay of `state`: its first point
   * on the chart, how many it has, and their times on the replay's clock,
   * when the replay's segments of it are the profile's point for point;
   * null otherwise. The replay's times are the logged ones smoothed
   * (initializeReplay), on the same segments of each flight it plays.
   */
  const replayRun = (state: ReplayState, k: number) => {
    const { first, last } = legs[k] ?? {
      first: 0,
      last: profile!.segments.length - 1,
    };
    const segments = state.segments;
    const leg = state.smoothed?.legs.find(
      (leg) => segments[leg.first]?.path_id === pathIds[k],
    );
    const count = last - first + 1;
    return leg && leg.end - leg.first === count
      ? { first, count, time: (i: number) => segments[leg.first + i]!.time! }
      : null;
  };

  /**
   * Move the replay's cursor to its time: on the flight it plays, at the
   * same point of the chart, of several flights the one of that flight
   */
  const followReplay = (state: ReplayState): void => {
    if (!profile) return;
    const curve = state.smoothed;
    const leg = curve?.legs[legAt(curve.legs, state.currentTime)];
    const run =
      leg &&
      replayRun(state, pathIds.indexOf(state.segments[leg.first]!.path_id));
    let point: ProfilePoint | null = null;
    if (run) {
      const at = locate(run.count, run.time, state.currentTime);
      point = { index: run.first + at.index, fraction: at.fraction };
    } else if (!legs.length) point = locateX(state.currentTime);
    setCursor(replayCursor, point);
  };

  /**
   * Move the strip into the replay panel as replay opens, in place of the
   * slider, and back out as it closes
   */
  const place = (): void => {
    const manager = app.replayManager;
    if (replaying()) {
      domCache.get("replay-slider-container")?.before(root);
      manager?.followTime(followReplay);
      followReplay(app.replayState);
    } else {
      document.body.append(root);
      manager?.followTime(null);
      setCursor(replayCursor, null);
      domCache.get("replay-controls")?.classList.remove("has-profile");
    }
    sync();
  };

  const seekWith = (manager: ReplayManager, point: ProfilePoint): void => {
    if (!app.replayActive) {
      // Where the map is: the seek below brings the airplane into view
      manager.toggleReplay(false);
      if (!app.replayActive) return;
    }
    // The same point of the flight there, on the replay's clock
    const run = replayRun(
      manager.state,
      legs.length ? legs.findIndex(({ last }) => point.index <= last) : 0,
    );
    if (!run && legs.length) return;
    manager.seekReplay(
      String(
        run
          ? valueAt(run.time, run.count, {
              index: point.index - run.first,
              fraction: point.fraction,
            })
          : at(profile!.x, point),
      ),
    );
  };

  /**
   * Show the replay at a point of the profile: opened there, paused, if it
   * is not running yet. A flight without times has no replay, alone or
   * among several, which a click (`click`) there says; those with times
   * open theirs on a profile along the distance as well.
   */
  const seek = (point: ProfilePoint, click = false): void => {
    if (!profile || app.wrappedVisible || replayingAll()) return;
    if (!timedAt(point)) {
      if (click) showToast(NO_TIMES_MESSAGE);
      return;
    }
    if (!app.replayActive) {
      if (!app.canReplay()) return;
      // Not while a mode holds the replay control, as its click says
      const held = heldReason(domCache.get("replay-btn"));
      if (held !== null) {
        showToast(held);
        return;
      }
    }
    const manager = app.replayManager;
    if (manager) {
      seekWith(manager, point);
      return;
    }
    const seeking = profile;
    void app.loadReplay().then((loaded) => {
      if (loaded && profile === seeking) seekWith(loaded, point);
    });
  };

  const dragTo = (event: PointerEvent): void => {
    if (!drag || !profile) return;
    if (Math.abs(event.clientX - drag.startX) > TAP_SLOP_PX) drag.moved = true;
    const point = pointAt(event.clientX);
    const seeks = drag.mouse || replaying();
    // Where the replay seeks to, the airplane marks the place
    showPoint(point, !seeks);
    // Said once for a press, not for every move of a drag
    if (seeks) seek(point, !drag.moved);
  };

  const stopDragging = (): void => {
    window.removeEventListener("pointermove", dragTo);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    drag = null;
  };

  const endDrag = (event: PointerEvent): void => {
    const ended = drag;
    stopDragging();
    // A tap opens replay there; a finger that moved only read
    const tap = ended && !ended.mouse && !ended.moved;
    if (tap && profile && event.type === "pointerup") {
      seek(pointAt(event.clientX), true);
    }
    // A finger that lifted points at nothing; the chart's pointerleave came
    // during the drag, which kept the values, or not at all, as a tap
    // moved the strip into the replay panel
    const onPlot = event.target instanceof Node && plot.contains(event.target);
    if (!ended?.mouse || !onPlot) leave();
  };

  plot.addEventListener(
    "pointermove",
    (event) => {
      if (!drag && event.pointerType === "mouse" && profile) {
        const point = pointAt(event.clientX);
        // A click replays a flight with times, wherever it is pointed at
        root.classList.toggle("is-timed", timedAt(point));
        showPoint(point, true);
      }
    },
    lifetime,
  );
  plot.addEventListener("pointerleave", leave, lifetime);
  plot.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0 || !profile) return;
      event.preventDefault();
      drag = {
        startX: event.clientX,
        moved: false,
        mouse: event.pointerType === "mouse",
      };
      // On the window: the strip moves into the replay panel as the drag
      // opens replay, and the plot under the pointer with it
      window.addEventListener("pointermove", dragTo);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("pointercancel", endDrag);
      dragTo(event);
    },
    lifetime,
  );
  toggle.addEventListener(
    "click",
    () => {
      collapsed = !collapsed;
      storeFlag(PROFILE_STORAGE_KEY, collapsed);
      sync();
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
              PROFILE_HEIGHT_VAR,
              `${height}px`,
            );
          }
        });
  resized?.observe(root);

  const store = app.store;
  store.subscribeKeys(
    ["selectedPathIds", "currentData", "selectedYear", "selectedAircraft"],
    refresh,
  );
  store.subscribeKeys(["replayActive"], place);
  store.subscribeKeys(["wrappedVisible"], sync);
  followCrossSection(app, sync, app.signal);
  // The flight under the pointer on the map: the cursor goes to the middle
  // of the segment, which runs from its start to the next one's, and to the
  // end of the last of a flight of several, rather than into the gap after
  // it, as on the chart (snapToLegs)
  const pathHover = app.layerManager.pathHover;
  pathHover.onHover = (segment) => {
    if (!profile || root.hidden || drag) return;
    const index = segment ? profile.segments.indexOf(segment) : -1;
    if (index < 0) leave();
    else {
      const last = legs.some((leg) => leg.last === index);
      showPoint({ index, fraction: last ? 0 : 0.5 }, false);
    }
  };
  // The chrome goes with the app (see MapApp.destroy)
  app.signal.addEventListener(
    "abort",
    () => {
      stopDragging();
      resized?.disconnect();
      marker?.remove();
      pathHover.onHover = null;
      app.replayManager?.followTime(null);
      domCache.get("replay-controls")?.classList.remove("has-profile");
      document.body.classList.remove("profile-open");
      root.remove();
      toggle.remove();
    },
    { once: true },
  );
  refresh();
  // A replay may be running already: the bundle was fetched for it
  if (replaying()) place();
  return root;
}
