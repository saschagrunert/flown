/**
 * Shared fixtures for the WrappedManager test files: a dialog fixture, a
 * small flight history with airports in two countries, and the mock app.
 */
import {
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";
import { siteData } from "../../../../flown/frontend/state/siteData";

export { el } from "../../testHelpers";

export function mountWrappedDom(): void {
  document.body.innerHTML = `
    <div id="app-container">
      <div id="map"></div>
    </div>
    <div id="left-buttons">
      <button id="stats-btn"></button>
      <button id="export-btn"></button>
      <button id="share-btn"></button>
      <button id="wrapped-btn"></button>
    </div>
    <div id="right-buttons">
      <button id="heatmap-btn"></button>
      <button id="airports-btn"></button>
      <button id="altitude-btn"></button>
      <button id="airspeed-btn"></button>
      <button id="aviation-btn"></button>
      <div id="year-filter"></div>
      <div id="aircraft-filter"></div>
    </div>
    <div id="stats-panel"></div>
    <div id="altitude-legend"></div>
    <div id="airspeed-legend"></div>
    <div id="loading"></div>
    <div id="wrapped-modal" hidden>
      <button id="wrapped-skip-btn" hidden>Skip intro</button>
      <button class="close-btn">Close</button>
      <div id="wrapped-content">
        <div id="wrapped-title"></div>
        <div id="wrapped-year"></div>
        <div id="wrapped-stats"></div>
        <button id="wrapped-more-btn">More below</button>
        <section id="wrapped-card-facts">
          <div id="wrapped-fun-facts"></div>
        </section>
        <section id="wrapped-card-fleet">
          <div id="wrapped-aircraft-fleet"></div>
        </section>
        <section id="wrapped-card-airports">
          <div id="wrapped-top-airports"></div>
          <div id="wrapped-airports-grid"></div>
        </section>
        <div id="wrapped-cards-column"></div>
        <div id="wrapped-map-container">
          <div id="wrapped-intro-title">
            <span id="wrapped-intro-heading"></span>
            <span id="wrapped-intro-year"></span>
          </div>
        </div>
      </div>
    </div>
    <div id="github-footer"></div>
  `;
}

/** Airports with countries, so the Wrapped sections can group and rank */
export function installAirports(): void {
  siteData.airports = [
    {
      name: "EDDF Frankfurt",
      lat: 50.03,
      lon: 8.57,
      code: "EDDF",
      country: "DE",
    },
    {
      name: "EDDM Munich",
      lat: 48.35,
      lon: 11.79,
      code: "EDDM",
      country: "DE",
    },
    {
      name: "EDDK Cologne",
      lat: 50.87,
      lon: 7.14,
      code: "EDDK",
      country: "DE",
    },
    {
      name: "LOWW Vienna",
      lat: 48.11,
      lon: 16.57,
      code: "LOWW",
      country: "AT",
    },
  ];
}

/** Two timed segments of one path, an hour of flying at 100 then 120 kt */
function flight(pathId: number, lat: number, lon: number) {
  return [
    createSegment({
      path_id: pathId,
      coords: [
        [lat, lon],
        [lat + 0.5, lon + 0.5],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 100,
      time: 0,
    }),
    createSegment({
      path_id: pathId,
      coords: [
        [lat + 0.5, lon + 0.5],
        [lat + 1, lon + 1],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 120,
      time: 3600,
    }),
  ];
}

/**
 * Three flights in 2024 (two in D-ABCD, one in D-EFGH) between Frankfurt,
 * Munich and Vienna, and one 2023 flight to Cologne.
 */
export function createFlightHistory() {
  return createDataset(
    [
      {
        id: 1,
        year: 2024,
        aircraft_registration: "D-ABCD",
        aircraft_type: "DA40",
        start_airport: "EDDF Frankfurt",
        end_airport: "EDDM Munich",
      },
      {
        id: 2,
        year: 2024,
        aircraft_registration: "D-ABCD",
        aircraft_type: "DA40",
        start_airport: "EDDM Munich",
        end_airport: "EDDF Frankfurt",
      },
      {
        id: 3,
        year: 2024,
        aircraft_registration: "D-EFGH",
        aircraft_type: "C172",
        start_airport: "EDDF Frankfurt",
        end_airport: "LOWW Vienna",
      },
      {
        id: 4,
        year: 2023,
        aircraft_registration: "D-ABCD",
        aircraft_type: "DA40",
        start_airport: "EDDF Frankfurt",
        end_airport: "EDDK Cologne",
      },
    ],
    [
      ...flight(1, 50, 8),
      ...flight(2, 48, 11),
      ...flight(3, 50, 9),
      ...flight(4, 50, 7),
    ],
    8,
  );
}

/** The model names metadata.json carries for the aircraft of the history */
const aircraftModels = {
  "D-ABCD": "Diamond DA40",
  "D-EFGH": "Cessna 172",
};

/** Needs `mountWrappedDom` first: the mock map moves into its `#map` */
export function createWrappedMockApp(): MockApp {
  return createMockApp({
    selectedYear: "2024",
    currentData: createFlightHistory(),
    aircraftModels,
    config: {
      bounds: [
        [50, 8],
        [52, 10],
      ],
      center: [51, 9],
      dataDir: "/data",
    },
  });
}
