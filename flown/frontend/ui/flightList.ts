/**
 * The flight list: the Flights tab of the statistics rail, one row per
 * flight of the year and aircraft filter.
 *
 * The rail is the phone's statistics sheet as well, so the same two tabs
 * serve both, and the bar keeps its five tabs. `flightListVisible` says
 * which tab is shown; the rail itself opens with `statsPanelVisible`.
 *
 * Part of the lazily loaded Wrapped bundle, like the statistics panel it
 * shares the rail with: the stats manager starts it (ui/statsManager.ts),
 * and until then the tabs are hidden and the rail says it is loading. The
 * list is written only while its tab is open, and again only when the
 * filter or the dataset changed; a selection only marks the rows.
 *
 * A flight is named by route, aircraft and year; the list starts in file
 * order, which the year files show anyway. Never a date: it would say when
 * somebody flew.
 */
import type { MapApp } from "../mapApp";
import type { PathInfo } from "../types";
import { datasetIndex, type FilterView } from "../calculations/datasetIndex";
import { flightTotals, type FlightTotals } from "../calculations/flightTotals";
import { KM_TO_NAUTICAL_MILES } from "../utils/constants";
import { domCache } from "../utils/domCache";
import { formatNumber } from "../utils/formatters";
import { formatFlightTime } from "../utils/statsFormat";
import { escapeHtml, pluralFlights } from "../utils/htmlGenerators";
import { flightLabel, flightRoute, pickBox } from "./airportFlights";
import type { PickList } from "./pathSelection";
import { setStatsTitle } from "./statsPanel";

/** The tab panel the list is written into (templates/map_template.html) */
const FLIGHT_LIST_PANEL_ID = "flight-list-panel";

/** One flight of the list */
export interface FlightRow {
  path: PathInfo;
  /** "EDAQ → EDDP" */
  route: string;
  totals: FlightTotals | undefined;
  /** What the search looks in, in lower case */
  searchText: string;
}

/** A column: its header, its cells and what it sorts by */
interface Column {
  /** The header's `data-sort`, which the e2e tests find it by */
  key: string;
  label: string;
  /** Said with the label where the header is short for it */
  title?: string;
  /** Figures: right aligned and sorted as numbers */
  numeric?: boolean;
  /** What the column sorts by; a flight without one sorts last */
  value(row: FlightRow): string | number | undefined;
  /** The cell's plain text */
  text(row: FlightRow): string;
  /** More about the cell, as its title */
  detail?(row: FlightRow): string | undefined;
}

/** Stands in for a figure the flight's log does not have */
const MISSING = "—";

/** A figure, or the stand-in where there is none */
function figure(value: number | undefined): string {
  return value === undefined ? MISSING : formatNumber(value);
}

/** "3 full stops, 12 touch-and-goes"; none for a flight without landings */
function landingDetail(row: FlightRow): string | undefined {
  const { landings, touch_and_goes: touchAndGoes = 0 } = row.path;
  if (landings === undefined) return undefined;
  return (
    formatNumber(landings) +
    (landings === 1 ? " full stop, " : " full stops, ") +
    formatNumber(touchAndGoes) +
    (touchAndGoes === 1 ? " touch-and-go" : " touch-and-goes")
  );
}

/** Nautical miles of a flight */
function distanceNm(row: FlightRow): number | undefined {
  return row.totals && row.totals.km * KM_TO_NAUTICAL_MILES;
}

/**
 * The columns, in order. The first one names the flight and carries its
 * button. A new column is one more entry here.
 */
export const COLUMNS: readonly Column[] = [
  {
    key: "route",
    label: "Route",
    value: (row) => row.route,
    text: (row) => row.route,
  },
  {
    key: "aircraft",
    label: "Aircraft",
    value: (row) => row.path.aircraft_registration,
    text: (row) => row.path.aircraft_registration ?? MISSING,
  },
  {
    key: "year",
    label: "Year",
    numeric: true,
    value: (row) => row.path.year,
    text: (row) =>
      row.path.year === undefined ? MISSING : String(row.path.year),
  },
  {
    key: "time",
    label: "Time",
    title: "Flight time",
    numeric: true,
    value: (row) => row.totals?.seconds,
    // As the statistics write it: a logbook's "1:25" reads as a time of day
    text: (row) => {
      const seconds = row.totals?.seconds;
      return seconds === undefined ? MISSING : formatFlightTime(seconds);
    },
  },
  {
    key: "distance",
    label: "nm",
    title: "Distance (nm)",
    numeric: true,
    value: distanceNm,
    text: (row) => figure(distanceNm(row)),
  },
  {
    key: "altitude",
    label: "Alt ft",
    title: "Highest altitude (ft MSL)",
    numeric: true,
    value: (row) => row.path.max_altitude_ft,
    text: (row) => figure(row.path.max_altitude_ft),
  },
  {
    // Written for flights with timestamps only; the others sort last
    key: "landings",
    label: "Ldg",
    title: "Full-stop landings",
    numeric: true,
    value: (row) => row.path.landings,
    text: (row) => figure(row.path.landings),
    detail: landingDetail,
  },
];

/** The sorted column and its direction; none keeps the file order */
export interface ListSort {
  key: string;
  descending: boolean;
}

/** The rows of a filter's flights, in file order */
export function flightRows(
  paths: readonly PathInfo[],
  totals: Map<number, FlightTotals>,
): FlightRow[] {
  return paths.map((path) => {
    const route = flightRoute(path);
    return {
      path,
      route,
      totals: totals.get(path.id),
      searchText: [
        route,
        path.start_airport,
        path.end_airport,
        path.aircraft_registration,
        path.aircraft_type,
      ]
        .join(" ")
        .toLowerCase(),
    };
  });
}

/**
 * The rows a search keeps: every word of it has to appear in the flight's
 * airports (code or name), registration or type
 */
export function searchRows(rows: FlightRow[], query: string): FlightRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  return rows.filter((row) =>
    words.every((word) => row.searchText.includes(word)),
  );
}

const collator = new Intl.Collator("en", { numeric: true });

/**
 * The rows in the order of a sort, or as they are without one. The sort is
 * stable, so rows that tie stay in file order, and a flight without the
 * value sorts last in either direction.
 */
export function sortRows(
  rows: FlightRow[],
  sort: ListSort | null,
): FlightRow[] {
  const column = sort && COLUMNS.find((c) => c.key === sort.key);
  if (!sort || !column) return rows;
  const sign = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? 1 : -1;
    }
    return (
      sign *
      (typeof x === "number" && typeof y === "number"
        ? x - y
        : collator.compare(String(x), String(y)))
    );
  });
}

/** The next sort after a click on a header: up, down, then file order */
export function nextSort(sort: ListSort | null, key: string): ListSort | null {
  if (sort?.key !== key) return { key, descending: false };
  return sort.descending ? null : { key, descending: true };
}

/**
 * The table's rows: the first cell is the flight's checkbox, which adds it
 * to the selection or takes it out, and its button
 */
function rowsHtml(rows: FlightRow[]): string {
  let html = "";
  for (const row of rows) {
    const id = row.path.id;
    html += "<tr>";
    for (const [i, column] of COLUMNS.entries()) {
      const text = escapeHtml(column.text(row));
      const detail = column.detail?.(row);
      html +=
        i === 0
          ? '<th scope="row">' +
            pickBox(id, escapeHtml(flightLabel(row.path, row.totals?.km))) +
            '<button type="button" class="kh-flight" data-path-id="' +
            id +
            '" aria-pressed="false">' +
            text +
            "</button></th>"
          : "<td" +
            (column.numeric ? ' class="kh-num"' : "") +
            (detail ? ' title="' + escapeHtml(detail) + '"' : "") +
            ">" +
            text +
            "</td>";
    }
    html += "</tr>";
  }
  return html;
}

/** The header row, one sort button per column */
function headerHtml(): string {
  let html = "<tr>";
  for (const column of COLUMNS) {
    html +=
      '<th scope="col" data-sort="' +
      column.key +
      '"' +
      (column.numeric ? ' class="kh-num"' : "") +
      '><button type="button"' +
      (column.title ? ' title="' + escapeHtml(column.title) + '"' : "") +
      ">" +
      escapeHtml(column.label) +
      "</button></th>";
  }
  return html + "</tr>";
}

export class FlightList {
  private readonly app: MapApp;
  private readonly panel: HTMLElement | null;
  private readonly body: HTMLElement | null = null;
  private readonly count: HTMLElement | null = null;
  private readonly search: HTMLInputElement | null = null;
  /** The filter the rows were made for; another one makes them again */
  private view: FilterView | null = null;
  private rows: FlightRow[] = [];
  /**
   * The flights of the rows shown, in their order, and the row of a Shift
   * range's start, made afresh with the rows and as the list closes
   */
  private picks: PickList = { order: [], anchor: null };
  private sort: ListSort | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  /** Removes the listeners on the page's own elements */
  private readonly listeners = new AbortController();

  constructor(app: MapApp) {
    this.app = app;
    this.panel = domCache.get(FLIGHT_LIST_PANEL_ID);
    const signal = this.listeners.signal;

    if (this.panel) {
      this.panel.innerHTML =
        '<div class="kh-flights-bar">' +
        '<input type="search" class="kh-flights-search" ' +
        'placeholder="Airport, registration or type" ' +
        'aria-label="Search flights" autocomplete="off" spellcheck="false">' +
        '<span class="kh-flights-count" role="status"></span>' +
        "</div>" +
        '<div class="kh-flights-scroll">' +
        '<table class="kh-flights"><thead>' +
        headerHtml() +
        "</thead><tbody></tbody></table></div>";
      this.body = this.panel.querySelector("tbody");
      this.count = this.panel.querySelector(".kh-flights-count");
      this.search = this.panel.querySelector("input");

      this.search?.addEventListener("input", () => this.writeRows(), {
        signal,
      });
      this.panel
        .querySelector("thead")
        ?.addEventListener("click", (event) => this.onHeaderClick(event), {
          signal,
        });
      this.body?.addEventListener("click", (event) => this.onRowClick(event), {
        signal,
      });
    }
    this.followTabs(signal);

    const store = app.store;
    this.unsubscribe.push(
      store.subscribeKeys(
        [
          "currentData",
          "selectedYear",
          "selectedAircraft",
          "statsPanelVisible",
          "flightListVisible",
        ],
        () => this.update(),
      ),
      store.subscribe("selectedPathIds", () => this.markSelected()),
    );
    this.update();
  }

  /** Stop following the store and the page; what the list shows stays */
  destroy(): void {
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe.length = 0;
    this.listeners.abort();
  }

  /**
   * Run the rail's two tabs: a click or the arrow keys (which wrap around),
   * Home and End pick one, and the store says which is open
   */
  private followTabs(signal: AbortSignal): void {
    const tabs = [domCache.get("stats-tab"), domCache.get("flights-tab")];
    tabs.forEach((tab, i) => {
      tab?.addEventListener(
        "click",
        () => {
          this.app.flightListVisible = i === 1;
        },
        { signal },
      );
      tab?.addEventListener(
        "keydown",
        (event) => {
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? 1
                : event.key === "ArrowLeft" || event.key === "ArrowRight"
                  ? 1 - i
                  : -1;
          if (next < 0) return;
          event.preventDefault();
          this.app.flightListVisible = next === 1;
          tabs[next]?.focus();
        },
        { signal },
      );
    });

    const sync = (flights: boolean): void => {
      tabs.forEach((tab, i) => {
        const selected = (i === 1) === flights;
        tab?.setAttribute("aria-selected", String(selected));
        tab?.setAttribute("tabindex", selected ? "0" : "-1");
      });
      const stats = domCache.get("stats-panel");
      if (stats) stats.hidden = flights;
      if (this.panel) this.panel.hidden = !flights;
      if (flights) {
        const title = document.querySelector(
          "#stats-rail-title .kh-stats-title-text",
        );
        if (title) title.textContent = "Flights";
      } else {
        setStatsTitle(this.app.selectedPathIds.size > 0);
      }
    };
    sync(this.app.flightListVisible);
    this.unsubscribe.push(this.app.store.subscribe("flightListVisible", sync));
    // Hidden in the page until now, when they work
    const tablist = domCache.get("stats-rail-tabs");
    if (tablist) tablist.hidden = false;
  }

  /**
   * Write the rows again if the list is open and its filter changed.
   * Closed, a Shift range starts afresh: the click it began at is out of
   * mind.
   */
  private update(): void {
    const app = this.app;
    const data = app.currentData;
    if (!app.statsPanelVisible || !app.flightListVisible || !this.body) {
      this.picks.anchor = null;
      return;
    }
    const view = data
      ? datasetIndex(data).filter(app.selectedYear, app.selectedAircraft)
      : null;
    if (view === this.view && this.view !== null) return;
    this.view = view;
    // No Year column while one year is shown (see wrapped.css)
    this.body.parentElement!.classList.toggle(
      "kh-one-year",
      app.selectedYear !== "all",
    );
    this.rows = data && view ? flightRows(view.paths, flightTotals(data)) : [];
    this.writeRows();
  }

  /** The rows the search keeps, in the order of the sort */
  private writeRows(): void {
    if (!this.body) return;
    const query = this.search?.value ?? "";
    const shown = sortRows(searchRows(this.rows, query), this.sort);
    this.picks = { order: shown.map((row) => row.path.id), anchor: null };
    const total = this.rows.length;
    this.body.innerHTML =
      shown.length > 0
        ? rowsHtml(shown)
        : '<tr><td class="kh-flights-empty" colspan="' +
          COLUMNS.length +
          '">' +
          (total > 0 ? "No flight matches" : "No flights") +
          "</td></tr>";
    if (this.count) {
      this.count.textContent =
        shown.length === total
          ? pluralFlights(total)
          : formatNumber(shown.length) + " of " + pluralFlights(total);
    }
    this.markSelected();
  }

  private markSelected(): void {
    if (!this.body) return;
    this.app.pathSelection.markSelected(
      this.body.querySelectorAll<HTMLElement>("[data-path-id]"),
    );
  }

  private onHeaderClick(event: Event): void {
    const header = (event.target as Element).closest<HTMLElement>(
      "th[data-sort]",
    );
    const key = header?.dataset["sort"];
    if (!key || !(event.target as Element).closest("button")) return;
    this.sort = nextSort(this.sort, key);
    for (const th of header.parentElement?.children ?? []) {
      if (this.sort && th === header) {
        th.setAttribute(
          "aria-sort",
          this.sort.descending ? "descending" : "ascending",
        );
      } else {
        th.removeAttribute("aria-sort");
      }
    }
    this.writeRows();
  }

  /**
   * A click anywhere on a row picks its flight; its checkbox, Ctrl or Cmd
   * add it to the selection (or take it out of it), and Shift the flights
   * from the row clicked last to this one (PathSelection.pickFromList)
   */
  private onRowClick(event: MouseEvent): void {
    const row = (event.target as Element)
      .closest("tr")
      ?.querySelector<HTMLElement>("[data-path-id]");
    if (!row) return;
    this.app.pathSelection.pickFromList(
      Number(row.dataset["pathId"]),
      event,
      this.picks,
    );
  }
}
