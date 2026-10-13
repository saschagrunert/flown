/**
 * Stats Manager - Handles statistics panel updates
 *
 * Part of the lazily loaded Wrapped bundle (wrapped.ts): the app starts it
 * the first time the panel opens (see ui/statsPanel.ts), and it follows the
 * store from then on. It starts the flight list of the rail's other tab
 * (ui/flightList.ts) as well, which costs the app nothing that way.
 */
import type { MapApp } from "../mapApp";
import type { FilteredStatistics, PathInfo, PathSegment } from "../types";
import { segmentsForPathIds } from "../calculations/statistics";
import {
  calculateFilteredStatistics,
  filterStatisticsInSlices,
} from "../calculations/panelStats";
import { logError } from "../utils/logger";
import { airportCode } from "../features/airports";
import { countryFlagSrc, groupByCountry } from "../features/countries";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { countryDisplayName, formatNumber } from "../utils/formatters";
import { escapeHtml, pluralize } from "../utils/htmlGenerators";
import {
  formatBuildDate,
  markFlightTimeUnits,
  splitAirportName,
} from "../utils/statsFormat";
import { icon, type IconName } from "../utils/icons";
import { domCache } from "../utils/domCache";
import { countryHeading } from "../utils/wrappedHtml";
import { datasetIndex, shownSelection } from "../calculations/datasetIndex";
import { watchScrollEnd, type ScrollEndWatcher } from "../utils/scrollFade";
import {
  LOADING_HTML,
  setStatsTitle,
  STATS_PANEL_ID as PANEL_ID,
} from "./statsPanel";
import { FlightList } from "./flightList";

/** Store keys the rendered statistics depend on */
const STATS_KEYS = [
  "currentData",
  "selectedPathIds",
  "selectedYear",
  "selectedAircraft",
] as const;

/** Everything a statistics render was computed from */
interface StatsInputs {
  pathInfo: PathInfo[];
  segments: PathSegment[];
  year: string;
  aircraft: string;
  /** Sorted selected path ids, or "" without a selection */
  selection: string;
}

/** Stand-in for a measurement the data does not carry */
const MISSING_VALUE = "—";

/** A single measurement: label, primary value and its metric equivalent */
interface Metric {
  /** Plain-text label, escaped at render */
  label: string;
  /** Primary value, without its unit */
  value: string;
  /** Unit of `value`, set against it at render (see `figure`) */
  unit: string;
  /** Same measurement in the other unit system, without its unit */
  alt?: string;
  /** Unit of `alt` */
  altUnit?: string;
}

/**
 * A number with its unit set against it: the stylesheet opens one hairline of
 * space rather than the word space this used to carry, the same treatment the
 * lead figures and the h and m of a flight time get. The two arrive
 * separately rather than as one formatted string because most callers of the
 * formatters want plain text, for a title or an aria-label, and only the
 * places that typeset a figure want the split.
 */
function figure(value: string, unit: string): string {
  return (
    escapeHtml(value) +
    (unit ? '<span class="stats-unit">' + escapeHtml(unit) + "</span>" : "")
  );
}

/**
 * One lead figure at the top of the panel.
 *
 * No space in the markup: `.stats-lead-unit` opens one hairline of
 * `--unit-gap` with a margin. The h and m that markFlightTimeUnits marks up
 * carry the same class and so are set the same way, which is the point.
 */
function leadItem(
  value: string,
  unit: string,
  label: string,
  altHtml?: string,
): string {
  return leadItemHtml(
    escapeHtml(value) +
      (unit
        ? '<span class="stats-lead-unit">' + escapeHtml(unit) + "</span>"
        : ""),
    label,
    altHtml,
  );
}

/**
 * A lead figure whose value is already marked up (see markFlightTimeUnits).
 *
 * Both `valueHtml` and `altHtml` are inserted as markup, so a caller escapes
 * whatever it puts in them, or builds them with `figure`, which escapes. They
 * are named for it: everything else in this module takes plain text and
 * escapes it here.
 */
function leadItemHtml(
  valueHtml: string,
  label: string,
  altHtml?: string,
): string {
  return (
    '<div class="stats-lead-item">' +
    '<span class="stats-lead-value">' +
    valueHtml +
    "</span>" +
    (altHtml ? '<span class="stats-lead-alt">' + altHtml + "</span>" : "") +
    '<span class="stats-lead-label">' +
    escapeHtml(label) +
    "</span>" +
    "</div>"
  );
}

/** One metric row: muted label left, value (and metric equivalent) right */
function metricRow(metric: Metric): string {
  return (
    '<li class="stats-metric">' +
    '<span class="stats-metric-label">' +
    escapeHtml(metric.label) +
    "</span>" +
    '<span class="stats-metric-values">' +
    '<span class="stats-metric-value">' +
    figure(metric.value, metric.unit) +
    "</span>" +
    (metric.alt
      ? '<span class="stats-metric-alt">' +
        figure(metric.alt, metric.altUnit ?? "") +
        "</span>"
      : "") +
    "</span>" +
    "</li>"
  );
}

/** Section heading: line icon, uppercase label and an optional count */
function sectionTitle(
  iconName: IconName,
  label: string,
  count?: number,
): string {
  return (
    '<h3 class="stats-section-title">' +
    icon(iconName, 16) +
    '<span class="stats-section-label">' +
    label +
    "</span>" +
    (count === undefined
      ? ""
      : '<span class="stats-section-count">' + count + "</span>") +
    "</h3>"
  );
}

/** A section of metric rows; empty when it has nothing to show */
function metricSection(
  iconName: IconName,
  label: string,
  metrics: Metric[],
): string {
  if (metrics.length === 0) return "";
  return (
    '<section class="stats-section">' +
    sectionTitle(iconName, label) +
    '<ul class="stats-list">' +
    metrics.map(metricRow).join("") +
    "</ul>" +
    "</section>"
  );
}

/** "15 airports in 6 countries" */
function airportSummary(numAirports: number, numCountries: number): string {
  const airports = pluralize(numAirports, "airport");
  if (numCountries <= 0) return airports;
  return airports + " in " + pluralize(numCountries, "country", "countries");
}

/** Airport list grouped by country, every entry with its code and name */
function airportGroups(grouped: Map<string, string[]>): string {
  let html = "";
  for (const [code, airports] of grouped) {
    html +=
      countryHeading(
        "stats-group",
        "stats-group",
        code,
        code === "Other" ? code : countryDisplayName(code),
        airports.length,
        countryFlagSrc(code),
        16,
        12,
      ) + '<ul class="stats-list stats-airport-list">';
    for (const name of airports) {
      const airport = splitAirportName(name, airportCode(name));
      html +=
        '<li class="stats-airport">' +
        (airport.code
          ? '<span class="stats-code">' + escapeHtml(airport.code) + "</span>"
          : "") +
        '<span class="stats-airport-name">' +
        escapeHtml(airport.name) +
        "</span>" +
        "</li>";
    }
    html += "</ul>";
  }
  return html;
}

/** Airports section: a summary line above the list, grouped by country */
function airportsSection(stats: FilteredStatistics): string {
  if (stats.airport_names.length === 0) return "";

  const grouped = groupByCountry(stats.airport_names);
  let numCountries = 0;
  for (const code of grouped.keys()) {
    if (code !== "Other") numCountries += 1;
  }

  return (
    '<section class="stats-section">' +
    sectionTitle("airport", "Airports", stats.num_airports) +
    '<p class="stats-airports-summary">' +
    airportSummary(stats.num_airports, numCountries) +
    "</p>" +
    '<div class="stats-groups">' +
    airportGroups(grouped) +
    "</div>" +
    "</section>"
  );
}

/** Aircraft section: registration, type and flight count per aircraft */
function aircraftSection(stats: FilteredStatistics): string {
  if (stats.num_aircraft === 0 || stats.aircraft_list.length === 0) return "";

  let rows = "";
  for (const aircraft of stats.aircraft_list) {
    rows +=
      '<li class="stats-metric stats-aircraft">' +
      '<span class="stats-metric-label">' +
      '<span class="stats-code">' +
      escapeHtml(aircraft.registration) +
      "</span>" +
      (aircraft.type
        ? '<span class="stats-aircraft-type">' +
          escapeHtml(aircraft.type) +
          "</span>"
        : "") +
      "</span>" +
      '<span class="stats-metric-values">' +
      '<span class="stats-metric-value">' +
      // The count in the figures' face, the noun in the text's
      formatNumber(aircraft.flights) +
      ' <span class="stats-noun">' +
      (aircraft.flights === 1 ? "flight" : "flights") +
      "</span>" +
      "</span>" +
      (aircraft.flight_time_str
        ? '<span class="stats-metric-alt">' +
          escapeHtml(aircraft.flight_time_str) +
          "</span>"
        : "") +
      "</span>" +
      "</li>";
  }

  return (
    '<section class="stats-section">' +
    sectionTitle("aircraft", "Aircraft", stats.num_aircraft) +
    '<ul class="stats-list">' +
    rows +
    "</ul>" +
    "</section>"
  );
}

/**
 * When and from which commit the site was built, if map_config.js says. The
 * hash links to its commit only when the build knew which repository that is.
 */
function buildInfo(config: MapApp["config"]): string {
  const { builtOn, commit, commitUrl } = config;
  const parts: string[] = [];
  const date = builtOn ? formatBuildDate(builtOn) : null;
  if (builtOn && date) {
    parts.push(
      '<time datetime="' + escapeHtml(builtOn) + '">' + date + "</time>",
    );
  }
  if (commit) {
    const hash = escapeHtml(commit);
    parts.push(
      "from " +
        (commitUrl?.startsWith("https://")
          ? '<a href="' +
            escapeHtml(commitUrl) +
            '" target="_blank" rel="noopener noreferrer">' +
            hash +
            "</a>"
          : hash),
    );
  }
  if (parts.length === 0) return "";
  return '<p class="stats-build">Built ' + parts.join(" ") + "</p>";
}

/** Distance rows beyond the lead figure */
function distanceMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];

  if (stats.num_paths > 0) {
    const avgDistanceNm = stats.total_distance_nm / stats.num_paths;
    metrics.push({
      label: "Average distance per trip",
      value: formatNumber(avgDistanceNm, 1),
      unit: "nm",
      alt: formatNumber(avgDistanceNm * NAUTICAL_MILES_TO_KM, 1),
      altUnit: "km",
    });
  }

  if (stats.longest_flight_nm && stats.longest_flight_nm > 0) {
    metrics.push({
      label: "Longest flight",
      value: formatNumber(stats.longest_flight_nm, 1),
      unit: "nm",
      alt: formatNumber(stats.longest_flight_km || 0, 1),
      altUnit: "km",
    });
  }

  return metrics;
}

/**
 * What the cruise figures are measured from: the terrain under the flights,
 * or for a filter with a flight the export has no terrain for, the flight's
 * own airfield (see heightsAboveGround in calculations/panelStats.ts)
 */
function cruiseReference(stats: FilteredStatistics): string {
  return stats.cruise_height_above_terrain === false ? "above field" : "AGL";
}

/** Groundspeed rows, knots first and km/h underneath */
function speedMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];
  const speeds: Array<[string, number | undefined]> = [
    ["Average groundspeed", stats.avg_groundspeed_knots],
    [
      "Cruise speed (> 1000 ft " + cruiseReference(stats) + ")",
      stats.cruise_speed_knots,
    ],
    ["Max groundspeed", stats.max_groundspeed_knots],
  ];

  for (const [label, knots] of speeds) {
    if (knots && knots > 0) {
      metrics.push({
        label,
        value: formatNumber(knots),
        unit: "kt",
        alt: formatNumber(knots * NAUTICAL_MILES_TO_KM),
        altUnit: "km/h",
      });
    }
  }

  return metrics;
}

/** Altitude rows, feet first and meters underneath */
function altitudeMetrics(stats: FilteredStatistics): Metric[] {
  const metrics: Metric[] = [];

  // 0 ft is an altitude; undefined means the filter has none
  if (stats.max_altitude_ft !== undefined) {
    metrics.push({
      label: "Max altitude (MSL)",
      value: formatNumber(stats.max_altitude_ft),
      unit: "ft",
      alt: formatNumber(stats.max_altitude_ft * FEET_TO_METERS),
      altUnit: "m",
    });

    if (stats.total_altitude_gain_ft !== undefined) {
      metrics.push({
        label: "Elevation gain",
        value: formatNumber(stats.total_altitude_gain_ft),
        unit: "ft",
        alt: formatNumber(stats.total_altitude_gain_ft * FEET_TO_METERS),
        altUnit: "m",
      });
    }
  }

  if (
    stats.most_common_cruise_altitude_ft &&
    stats.most_common_cruise_altitude_ft > 0
  ) {
    metrics.push({
      label: "Most common cruise altitude (" + cruiseReference(stats) + ")",
      value: formatNumber(stats.most_common_cruise_altitude_ft),
      unit: "ft",
      alt: formatNumber(stats.most_common_cruise_altitude_m || 0),
      altUnit: "m",
    });
  }

  return metrics;
}

/**
 * Landing rows: the full stops, touch-and-goes and go-arounds the build
 * found in the logs (flown/landings.py), none for a filter whose
 * flights carry none
 */
function landingMetrics(stats: FilteredStatistics): Metric[] {
  const landings = stats.landings;
  if (!landings) return [];
  const count = (label: string, value: number): Metric => ({
    label,
    value: formatNumber(value),
    unit: "",
  });
  return [
    count("Full-stop landings", landings.landings),
    count("Touch-and-goes", landings.touchAndGoes),
    // Low approaches among them: GPS cannot tell the two apart
    count("Go-arounds", landings.goArounds),
  ];
}

export class StatsManager {
  private app: MapApp;
  /** Markup of the last render; an identical result is not written again */
  private lastHtml: string | null = null;
  /** Keeps the panel's bottom fade in step with what it holds */
  private scrollWatcher: ScrollEndWatcher | null = null;
  /** What the last statistics were computed from; identical inputs skip it */
  private lastInputs: StatsInputs | null = null;
  /** Stops the statistics the panel waits for, null when it waits for none */
  private statsAbort: AbortController | null = null;
  /** Stops following the store (see destroy) */
  private readonly unsubscribe: (() => void)[];
  /** The Flights tab of the same rail */
  private readonly flightList: FlightList;

  constructor(app: MapApp) {
    this.app = app;

    // The panel follows the data, the filters and the selection; nothing has
    // to call it. The statistics walk every segment of the filter, so they
    // are only computed for an open panel (the rail open on its Statistics
    // tab), and once per update however many of the keys it changed.
    const showing = (): boolean =>
      app.statsPanelVisible && !app.flightListVisible;
    const followData = app.store.subscribeKeys(
      [...STATS_KEYS, "flightListVisible"],
      () => {
        if (showing()) this.updateStatsForSelection();
      },
    );
    // The rail on desktop and the Stats tab on mobile both open this panel
    // through the same key. Opening it renders whatever changed while it was
    // closed; lastInputs skips the work when nothing did.
    const followPanel = app.store.subscribe("statsPanelVisible", () => {
      if (!showing()) return;
      this.updateStatsForSelection();
      // A closed rail measures zero, so whatever the panel was told about
      // its own overflow while it was hidden was "everything fits". The
      // next frame is the first one that can measure it.
      requestAnimationFrame(() => this.scrollWatcher?.update());
    });

    // The rail holds around twice its own height of content on a phone, and
    // it used to end in a row sliced in half wherever the panel stopped
    const panel = domCache.get(PANEL_ID);
    if (panel) this.scrollWatcher = watchScrollEnd(panel);
    this.unsubscribe = [followData, followPanel];
    // The rail's other tab, which runs both tabs
    this.flightList = new FlightList(app);

    // Started by the first opening of the panel, which is over by the time
    // the bundle has arrived: it shows what it holds straight away
    if (showing()) this.updateStatsForSelection();
  }

  /**
   * Stop following the store, and the size and scroll of the panel: the
   * watcher of its fade listens to the window and observes the panel for
   * as long as it is not stopped. What the panel shows stays.
   */
  destroy(): void {
    this.statsAbort?.abort();
    for (const stop of this.unsubscribe) stop();
    this.unsubscribe.length = 0;
    this.scrollWatcher?.stop();
    this.scrollWatcher = null;
    this.flightList.destroy();
  }

  /** The inputs of the current state, in a shape that compares cheaply */
  private currentInputs(): StatsInputs {
    return {
      pathInfo: this.app.fullPathInfo ?? [],
      segments: this.app.fullPathSegments ?? [],
      year: this.app.selectedYear,
      aircraft: this.app.selectedAircraft,
      // Of the flights the filter shows, apart from no selection at all
      selection:
        this.app.selectedPathIds.size === 0
          ? ""
          : "#" +
            Array.from(shownSelection(this.app))
              .sort((a, b) => a - b)
              .join(","),
    };
  }

  private static sameInputs(a: StatsInputs, b: StatsInputs): boolean {
    return (
      a.pathInfo === b.pathInfo &&
      a.segments === b.segments &&
      a.year === b.year &&
      a.aircraft === b.aircraft &&
      a.selection === b.selection
    );
  }

  /**
   * Render the statistics of the current filter, or of the selection when
   * there is one. The calculation walks every segment, so it only runs
   * when something it depends on has changed; a selection click that ends
   * in the same state as before costs nothing.
   */
  updateStatsForSelection(): void {
    const inputs = this.currentInputs();
    if (this.lastInputs && StatsManager.sameInputs(this.lastInputs, inputs)) {
      return;
    }
    this.lastInputs = inputs;
    this.statsAbort?.abort();
    this.statsAbort = null;

    const { pathInfo, segments } = inputs;
    const selected = this.app.selectedPathIds;
    const data = this.app.currentData;

    if (selected.size === 0 && data) {
      // Clearing a selection comes back to the filter's statistics, which
      // are kept with the dataset instead of computed again every time.
      // Worked out in slices, as Wrapped's (see filterStatisticsInSlices):
      // all the years took a third of a second on a phone in one task.
      const controller = new AbortController();
      const stats = filterStatisticsInSlices(
        datasetIndex(data).filter(inputs.year, inputs.aircraft),
        controller.signal,
      );
      if (!(stats instanceof Promise)) {
        this.updateStatsPanel(stats, false);
        return;
      }
      this.statsAbort = controller;
      const panel = domCache.get(PANEL_ID);
      if (panel) {
        this.titleRail(false);
        panel.innerHTML = LOADING_HTML;
        panel.setAttribute("aria-busy", "true");
        this.lastHtml = null;
      }
      stats.then(
        (filtered) => {
          if (controller.signal.aborted) return;
          this.statsAbort = null;
          this.updateStatsPanel(filtered, false);
        },
        (error: unknown) => {
          if (!controller.signal.aborted) logError(error);
        },
      );
      return;
    }
    if (selected.size === 0) {
      this.updateStatsPanel(
        calculateFilteredStatistics({ pathInfo, segments }),
        false,
      );
      return;
    }

    // The selected flights the filter shows, as the map and the chip count
    // them: share mode keeps the ones it hides, which are of no figure
    const shown = shownSelection(this.app);
    const selectedPathInfo = pathInfo.filter((path) => shown.has(path.id));
    const selectedSegments = segmentsForPathIds(segments, shown);

    // A selection without segments still gets rendered: leaving the previous
    // flight's numbers under the title of a selection would be worse
    const selectedStats = calculateFilteredStatistics({
      pathInfo: selectedPathInfo,
      segments: selectedSegments,
      year: "all", // Don't filter by year for selection
      aircraft: "all", // Don't filter by aircraft for selection
    });

    this.updateStatsPanel(selectedStats, true);
  }

  /**
   * Title the rail for the statistics, but not over the Flights tab, which
   * titles it itself: the statistics worked out in slices land after a
   * switch to it, and the loading state and the figures both named the
   * rail "Statistics" there
   */
  private titleRail(isSelection: boolean): void {
    if (!this.app.flightListVisible) setStatsTitle(isSelection);
  }

  updateStatsPanel(stats: FilteredStatistics, isSelection: boolean): void {
    const panel = domCache.get(PANEL_ID);
    if (!panel) return;
    // The wait for the statistics, or for this code, is over
    panel.removeAttribute("aria-busy");

    this.titleRail(isSelection);

    let html = '<div class="stats-body">';

    // What the figures are of: the selection, or the year and aircraft of
    // the filter, which neither the phone's sheet nor the rail said
    const { selectedYear: year, selectedAircraft: aircraft } = this.app;
    html +=
      '<div class="stats-note">' +
      (isSelection
        ? "Showing statistics for " +
          pluralize(stats.num_paths, "selected flight")
        : // The year as the link or the saved view had it, which is
          // checked against the years only once they are known
          (year === "all" ? "All years" : escapeHtml(year)) +
          " · " +
          (aircraft === "all" ? "All aircraft" : escapeHtml(aircraft))) +
      "</div>";

    // Lead figures: what the flying adds up to
    const distanceKm = stats.total_distance_nm * NAUTICAL_MILES_TO_KM;
    html +=
      '<div class="stats-lead">' +
      leadItem(
        formatNumber(stats.total_distance_nm, 1),
        "nm",
        "Distance",
        figure(formatNumber(distanceKm, 1), "km"),
      ) +
      // Kept even without timing data so the grid always reads as four cells
      leadItemHtml(
        stats.total_flight_time_str
          ? markFlightTimeUnits(stats.total_flight_time_str, "stats-lead-unit")
          : escapeHtml(MISSING_VALUE),
        "Total flight time",
      ) +
      leadItem(formatNumber(stats.num_paths), "", "Flights") +
      leadItem(formatNumber(stats.num_airports), "", "Airports") +
      "</div>";

    html += metricSection("distance", "Distance", distanceMetrics(stats));
    html += metricSection("speed", "Speed", speedMetrics(stats));
    html += metricSection("altitude", "Altitude", altitudeMetrics(stats));
    html += metricSection("airport", "Landings", landingMetrics(stats));
    html += aircraftSection(stats);
    html += airportsSection(stats);

    // Data points measure the export, not the flying
    html +=
      '<p class="stats-footer">' +
      pluralize(stats.total_points, "data point") +
      "</p>";
    html += buildInfo(this.app.config);

    html += "</div>";

    // Rewriting identical markup reflows the whole list and drops focus out
    // of the panel, and most refreshes produce exactly the same content
    if (html === this.lastHtml && panel.firstChild !== null) return;
    this.lastHtml = html;
    panel.innerHTML = html;
    // New content, so whether there is more of it below has changed too
    this.scrollWatcher?.update();
  }
}
