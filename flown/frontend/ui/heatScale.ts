/**
 * The heat scale: which colour of the heat ramp (HEATMAP_GRADIENT in
 * ui/heatmapPaint.ts) a flight's worth of heat is drawn in, as the
 * map draws the heat right now. The heat legend (ui/heatLegend.ts) reads
 * it, and whatever else says what a colour of the heat means should too:
 * this is the one place that knows how each way of drawing the heat is
 * exposed, so a change to an exposure changes it here (and the keys the
 * legend follows, see followHeatLegend).
 *
 * A flight's worth is the heat one flight leaves over a place, as a lone
 * cruise at 100 kt does: the time it spends there (heatWeight in
 * calculations/heatLines.ts). The heat of flights that overlap adds up in
 * all three ways the heat is drawn, so n flights' worth is drawn at n
 * times the density of one, up to the knee all three roll it off from
 * alike (see calculations/heatTone.ts, which the legend reads its colours
 * back through):
 * - The flat heatmap weighs its points by that heat and puts the ridge of
 *   a lone track at the ramp's third colour, a density of 0.015
 *   (HEAT_FLIGHT_DENSITY, see HEATMAP_REFERENCE_INTENSITY), at every zoom,
 *   times the exposure of the flights it draws (heatmapExposure, see
 *   heatExposure in calculations/heatExposure.ts).
 * - The heat lines it hands over to (HEAT_LINES) colour the seconds spent
 *   around a fix (see calculations/heatLines.ts), scaled by the same
 *   exposure: a lone pass leaves the time between two fixes there, which
 *   they draw rounded to 4 s in that same colour, and n passes in the
 *   colour of n times the density (HEAT_LINE_SECONDS). The two agree, and
 *   the hand-over changes nothing here.
 * - The heat cloud of the 3D view fills its colours so that a lone cruise
 *   at full strength glows as the heatmap does at that density (see
 *   CLOUD_COLOUR in ui/heatCloudShaders.ts). It draws its heat with the gain
 *   of its look and an exposure of its own that follows its busiest cells,
 *   and hands their product to the store where the map comes to rest
 *   (heatCloudScale, see ui/heatCloud.ts).
 *
 * The heatmap and the cloud count the heat whatever the pace of the fixes.
 * The lines add it up in cells 40 m wide, which a lone pass logged every
 * few seconds leaves the time between two fixes in: made for a fix about
 * every 4 s, they draw a log of a fix a second as about a quarter of a
 * flight. And the heatmap's kernel is a fixed number of pixels, which
 * cover less ground towards the poles. Hence "about" in the legend.
 */
import type { MapApp } from "../mapApp";
import { HEAT_FLIGHT_DENSITY } from "../calculations/heatExposure";

/**
 * The density on the heat ramp (from 0 to 1, see HEATMAP_GRADIENT) that a
 * flight's worth of heat is drawn at now: by the heat cloud while it
 * stands in for the heatmap (as a lone cruise at full strength until it
 * has points), else by the heatmap and its lines
 */
export function heatScale(app: MapApp): number {
  return (
    HEAT_FLIGHT_DENSITY *
    (app.heatCloud ? app.heatCloudScale || 1 : app.heatmapExposure)
  );
}
