/**
 * The flights of an airport, listed in its popup.
 *
 * A click on a path is the only other way to select a single flight, and a
 * keyboard cannot click a path, so without this list replay, which plays
 * the selected flights, was out of a keyboard's reach. A row picks its
 * flight alone, and its checkbox adds it to the selection or takes it out:
 * that is how flights of the airport join a selection made already, or the
 * flights of share mode (see PathSelection.pickFromList). Each flight is
 * named by its route, aircraft, year and distance only: a date or a time
 * of day would say when somebody flew.
 *
 * AirportManager adds it whenever the popup is open with new content (see
 * listPopupFlights), and lays the popup out again afterwards. The runways
 * the flights of the filter touched down on go above it, with their share.
 * It is part of the app rather than of the feature bundle: fetching that
 * bundle, and its stylesheet, for the first popup cost far more than the
 * list itself.
 */
import type { Popup } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathInfo } from "../types";
import { datasetIndex } from "../calculations/datasetIndex";
import { flightTotals } from "../calculations/flightTotals";
import { KM_TO_NAUTICAL_MILES } from "../utils/constants";
import { escapeHtml } from "../utils/htmlGenerators";
import { airportCode } from "../features/airports";
import { watchScrollEnd, type ScrollEndWatcher } from "../utils/scrollFade";
import type { PickList } from "./pathSelection";

/** Apps whose selection the open list already follows */
const following = new WeakSet<MapApp>();

/** Keeps the fade of the list that is shown; one popup, so one list */
let listEnd: ScrollEndWatcher | null = null;

/** An airport as the list names it: its code where it has one */
function routeEnd(label = "?"): string {
  return airportCode(label) ?? label;
}

/**
 * A flight's route by the codes of its airports ("EDAQ → EDDP"), the way
 * this list and the flight list of the statistics rail name it
 */
export function flightRoute(path: PathInfo): string {
  return routeEnd(path.start_airport) + " → " + routeEnd(path.end_airport);
}

/**
 * How a list names a flight: its route, aircraft, year and the `km` it
 * covered, in nautical miles. The airport popup's rows and the checkboxes
 * of both lists say it, so a row is not one of several "EDXX → EDXX"
 * circuits of one aircraft alike.
 */
export function flightLabel(path: PathInfo, km = 0): string {
  // Under half a mile says nothing a row could tell apart: none rather
  // than "0 nm"
  const nm = Math.round(km * KM_TO_NAUTICAL_MILES);
  return [
    flightRoute(path),
    path.aircraft_registration,
    path.year,
    nm && nm + " nm",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The checkbox of a listed flight, which adds it to the selection or takes
 * it out, while the rest of its row picks it alone (see
 * PathSelection.pickFromList). Named after the flight by `label`, which is
 * escaped already. This list and the flight list of the statistics rail
 * have one per row.
 */
export function pickBox(id: number, label: string): string {
  return (
    '<input type="checkbox" class="kh-pick" data-path-id="' +
    id +
    '" aria-label="Select ' +
    label +
    '">'
  );
}

/**
 * Add the flight list to an airport popup whose content was just written.
 * @param app - The app whose flights and selection are listed
 * @param popup - The airports' popup, open on the map for this airport
 * @param name - The airport the popup is open for
 */
export function listFlights(app: MapApp, popup: Popup, name: string): void {
  // A closed popup has no element at all
  const container = popup.isOpen() ? popup.getElement() : undefined;
  const host = container?.querySelector(".kh-popup-airport");
  const data = app.currentData;
  if (!container || !host || !data) return;
  if (host.querySelector(".kh-popup-flights")) return;

  // MapLibre closes a popup on a click, never on a key
  container.onkeydown = (event) => {
    if (event.key === "Escape") popup.remove();
  };

  const byId = datasetIndex(data).pathInfoById;
  // The distances of the flight list, worked out once per dataset
  const totals = flightTotals(data);
  let html = "";
  /** The flights in the order of the rows, for a Shift click's range */
  const order: number[] = [];
  const picks: PickList = { order, anchor: null };
  for (const id of app.airportToPaths[name] ?? []) {
    const path = byId.get(id);
    if (!path) continue;
    order.push(id);
    const label = escapeHtml(flightLabel(path, totals.get(id)?.km));
    html +=
      "<div>" +
      pickBox(id, label) +
      '<button type="button" class="kh-popup-flight" data-path-id="' +
      id +
      '">' +
      label +
      "</button></div>";
  }
  if (!html) return;

  const use = runwayUse(
    datasetIndex(data).filter(app.selectedYear, app.selectedAircraft).paths,
    airportCode(name),
  );
  if (use) {
    const label = document.createElement("div");
    label.className = "popup-section-label kh-popup-flights-label";
    label.textContent = "Runways";
    const runways = document.createElement("div");
    runways.className = "kh-popup-runways";
    runways.textContent = use;
    host.append(label, runways);
  }

  const title = document.createElement("div");
  title.className = "popup-section-label kh-popup-flights-label";
  title.textContent = "Flights";
  const list = document.createElement("div");
  list.className = "kh-popup-flights";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Flights");
  list.innerHTML = html;
  host.append(title, list);
  // A long list stops mid-row; the bottom fades while there is more
  listEnd?.stop();
  const watcher = watchScrollEnd(list);
  listEnd = watcher;
  popup.once("close", () => watcher.stop());

  list.addEventListener("click", (event) => {
    const row = (event.target as Element).closest<HTMLElement>(
      "[data-path-id]",
    );
    if (row) {
      app.pathSelection.pickFromList(
        Number(row.dataset["pathId"]),
        event,
        picks,
      );
    }
  });

  markSelected(app);
  if (!following.has(app)) {
    following.add(app);
    app.store.subscribe("selectedPathIds", () => markSelected(app));
  }
}

/**
 * The runways the flights touched down on at an airport, the most used
 * first, each with its share of the touchdowns there that have a runway
 * (PathInfo.touchdowns): "RWY 29 · 65%, RWY 11 · 35%". Empty for none.
 * @param paths - The flights of the filter
 * @param code - The airport's ICAO code
 */
export function runwayUse(paths: PathInfo[], code?: string): string {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const path of paths) {
    for (const [airport, runway] of path.touchdowns ?? []) {
      if (airport === code && runway) {
        counts[runway] = (counts[runway] ?? 0) + 1;
        total++;
      }
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([runway, count]) =>
        `RWY ${runway} · ${Math.round((count * 100) / total)}%`,
    )
    .join(", ");
}

/**
 * Mark the listed flights that are part of the selection. Opening the popup
 * with nothing selected selects every flight of the airport, which pressed
 * every row: the list looked like a choice already made. While all of them
 * are selected they stay pressed for a screen reader, and the stylesheet
 * draws them as rows to pick from (`is-all-pressed`), unless there is only
 * one.
 */
function markSelected(app: MapApp): void {
  app.pathSelection.markSelected(
    document.querySelectorAll<HTMLElement>(".kh-popup-flights [data-path-id]"),
  );
  const buttons = document.querySelectorAll<HTMLElement>(".kh-popup-flight");
  // The one flight of an airport pressed or not is the whole choice, and
  // drawn unpressed both ways a press on it showed nothing
  document
    .querySelector(".kh-popup-flights")
    ?.classList.toggle(
      "is-all-pressed",
      buttons.length > 1 &&
        [...buttons].every(
          (button) => button.getAttribute("aria-pressed") === "true",
        ),
    );
}
