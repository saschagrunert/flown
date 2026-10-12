/**
 * The source and layers of the cross-section's corridor on their own
 * (ui/crossSectionCorridor.ts), on a map that has only what each test puts
 * on it. crossSection.test.ts drives them through the tool.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import {
  addLayers,
  corridorData,
  CROSS_SECTION_LAYERS,
  CROSS_SECTION_SOURCE,
  removeLayers,
  tooShort,
} from "../../../../flown/frontend/ui/crossSectionCorridor";
import { MAP_LAYERS } from "../../../../flown/frontend/utils/constants";

interface AddedLayer {
  id: string;
  paint: Record<string, unknown>;
}

/** A map of sources and layers by id, recording where each layer went */
function fakeMap(layerIds: string[] = []) {
  const sources = new Map<string, unknown>();
  const layers = new Map<string, AddedLayer | null>(
    layerIds.map((id) => [id, null]),
  );
  const before: (string | undefined)[] = [];
  const map = {
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, source: unknown) => sources.set(id, source),
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (layer: AddedLayer, beforeId?: string) => {
      layers.set(layer.id, layer);
      before.push(beforeId);
    },
    removeLayer: (id: string) => layers.delete(id),
  } as unknown as MapLibreMap;
  return { map, sources, layers, before };
}

describe("corridor layers", () => {
  it("go on top where the map has no airport labels to go under", () => {
    const { map, sources, layers, before } = fakeMap();

    addLayers(map);

    expect([...sources.keys()]).toEqual([CROSS_SECTION_SOURCE]);
    expect([...layers.keys()]).toEqual(Object.values(CROSS_SECTION_LAYERS));
    expect(before).toEqual([undefined, undefined, undefined]);
    // The stylesheet's accent, or its fallback where it has none
    expect(layers.get(CROSS_SECTION_LAYERS.corridor)?.paint["fill-color"]).toBe(
      "#4facfe",
    );
  });

  it("go under the airport labels and add only what is missing", () => {
    const { map, layers, before } = fakeMap([
      MAP_LAYERS.airportLabels,
      CROSS_SECTION_LAYERS.edge,
    ]);

    addLayers(map);
    addLayers(map);

    expect(before).toEqual([
      MAP_LAYERS.airportLabels,
      MAP_LAYERS.airportLabels,
    ]);
    expect(layers.size).toBe(4);
  });

  it("are removed with their source, and removing nothing is fine", () => {
    const { map, sources, layers } = fakeMap();
    addLayers(map);

    removeLayers(map);
    removeLayers(map);

    expect(sources.size).toBe(0);
    expect(layers.size).toBe(0);
  });
});

describe("corridorData", () => {
  it("is empty without both ends", () => {
    expect(corridorData([47, 8], null, 500).features).toEqual([]);
    expect(corridorData(null, [47, 9], 500).features).toEqual([]);
  });

  it("holds the corridor and the line between two ends", () => {
    const kinds = corridorData([47, 8], [47, 9], 500).features.map(
      (feature) => feature.properties?.["kind"] as string,
    );
    expect(kinds).toEqual(["corridor", "line"]);
  });
});

describe("tooShort", () => {
  it("refuses ends less than a metre apart", () => {
    expect(tooShort([47, 8], [47, 8])).toBe(true);
    expect(tooShort([47, 8], [47, 8.001])).toBe(false);
  });
});
