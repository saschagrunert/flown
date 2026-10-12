/**
 * The layer that draws the heat of the 3D view as a cloud in the air (see
 * ui/heatCloud.ts): a MapLibre custom layer with shaders of its own, since
 * no style layer draws a glow at a height. Every stretch between two
 * points of the cloud (calculations/heatCloud.ts) is a quad on the screen
 * around its two ends, and each of its pixels gets the heat of the
 * stretch spread along it and blurred across it: a Gaussian of the
 * distance to the stretch, integrated along it from the join with the
 * stretch before to the join with the one after. The joins are the
 * bisectors of the bends, so the stretches of a flight add up to the blur
 * of the whole line without a gap or a bead where one ends and the next
 * begins (round ends overlapped into beads, see the heat lines in
 * mapLayers.ts), and a stretch shorter than its blur is a soft point.
 *
 * The blur is as wide on the screen at the middle of the map at every zoom out
 * to a region, and narrows closer in (CLOUD_STOPS); it is wider in front of the
 * middle and narrower behind it in a tilted view, like everything else there.
 * The heat of a stretch is the seconds spent on it over the pixels it spans, so
 * a lone flight glows alike at every zoom out to a region and at every depth,
 * as the heatmap's intensity keeps a lone track alike by zoom (see
 * heatmapIntensity), and a slow one, a circuit or the taxiing, glows brighter.
 * The glows are added up over what the map has drawn (see CLOUD_COLOUR), so
 * where flights overlap the cloud glows brighter, from blue over cyan to white.
 *
 * It is drawn as a 3D layer, before the ribbons (see ui/heatCloud.ts): against
 * the relief in the depth buffer, so a mountain in front of a flight hides its
 * glow, but without writing to it, so the glow of one flight does not hide
 * another's, and the ribbons are drawn over it. Each glow is pulled towards the
 * camera by its reach for that test, and near the ground as far as the ground
 * in front of it rises, so a fix on the ground glows round rather than cut in
 * half by the ground in front of it. MapLibre's own projection code (the
 * prelude it hands a custom layer) projects the points, which makes the same
 * shaders work on the globe; the points are given from an origin near them, so
 * a 32-bit float keeps them to a fraction of a pixel close in.
 *
 * Three things help to read it. A faint copy of the glow on the ground under
 * the flights, its shadow, shows how high they were. Pulses run along every
 * track the way it was flown, by the time of its points, which shows the
 * direction of a circuit and the usual ways in and out; they rest while the map
 * is not used and under reduced motion, and the map draws no frame for them
 * then, and an exported image has none. Faint marks along the tracks, pointing
 * the way they were flown, take over from them whenever they do not run (see
 * CLOUD_MARK_SPACING_PX), so the direction still shows under reduced motion, on
 * a map at rest, in an exported image and in the cloud of a replay, faint or
 * building up behind the replay of all flights. And the exposure follows the
 * heat: the busiest cells of the cloud glow no brighter than white, however
 * many flights the filters keep (see cloudExposure).
 *
 * The constants named here and the shaders are in ui/heatCloudShaders.ts.
 */
import type {
  CustomLayerInterface,
  CustomRenderMethodInput,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { CloudPoints } from "../calculations/heatCloud";
import { mercatorOf } from "../utils/mercator";
import {
  drawing,
  LayerGl,
  mercatorUnitMetres,
  setDepth,
  setProjection,
  worldCopies,
} from "./glLayer";
import {
  ATTRIBUTES,
  CLOUD_COLOUR,
  CLOUD_FADE_S,
  CLOUD_FLOW_CYCLE_S,
  CLOUD_FLOW_IDLE_MS,
  CLOUD_FLOW_SPACING_PX,
  CLOUD_FLOW_STRENGTH,
  CLOUD_FLOW_WAKE,
  CLOUD_GROUND_SLACK_FT,
  CLOUD_MARK_SPACING_PX,
  CLOUD_REFERENCE_SPEED_MS,
  CLOUD_SHADOW_CEILING,
  CLOUD_SHADOW_COLOUR,
  CLOUD_SHADOW_LIFT_FT,
  CLOUD_SIGMA_FLOOR_PX,
  CLOUD_SIGMA_MOST,
  FRAGMENT_SHADER,
  UNIFORMS,
  VERTEX_SHADER,
  cloudExposure,
  cloudLook,
  layout,
  markStrength,
} from "./heatCloudShaders";
import { isMapStill } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";

/** The id of the cloud's layer on the map */
export const HEAT_CLOUD_LAYER = "heat-cloud";

/** What the layer asks the app for every frame it draws */
export interface HeatCloudStyle {
  /**
   * The metres a foot of the ground and a foot of the height above it is
   * drawn as: the exaggeration of the relief, and 0 for the ground where
   * the map draws no relief and for the height where the 3D view draws
   * the flights flat (see isLiftedAt)
   */
  groundM: number;
  liftM: number;
  /**
   * How strongly the cloud is drawn, from 0 to 1 (see dimsHeatCloud): the
   * most of white it fills a pixel to; below 1 without its shadow
   */
  opacity: number;
  /** Whether its pulses may run (see CLOUD_FLOW_SPACING_PX) */
  flow: boolean;
  /**
   * The seconds into every flight its heat is drawn up to, by the clock of
   * the replay of all flights (see flightClock); all of it without
   */
  until?: number | undefined;
  /**
   * How much of its glow is drawn, 1 unless it fades out (see
   * CLOUD_HANDOVER_MS in ui/heatCloud.ts): its heat is scaled by it, so
   * the map under it comes back as it goes. A lower `opacity` moves what
   * it glows over towards that much of white, which darkened the heatmap
   * under a cloud faded by it to red.
   */
  fade?: number | undefined;
}

export class HeatCloudLayer implements CustomLayerInterface {
  readonly id = HEAT_CLOUD_LAYER;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  /** Frames the layer has drawn the cloud in, for the e2e tests */
  frames = 0;
  /** The stretches it drew in the last of them */
  drawn = 0;
  /**
   * How strongly it drew the pulses and the marks in the last of them,
   * for the e2e tests (see markStrength)
   */
  pulses = 0;
  marks = 0;
  private map: MapLibreMap | null = null;
  /** Its GL objects, made as it first draws (see LayerGl) */
  private readonly objects: LayerGl<(typeof UNIFORMS)[number]>;
  private cloud: CloudPoints | null = null;
  /** When the last frame was drawn, and the map last used (performance.now) */
  private drawnAt = 0;
  private usedAt = 0;
  /** How strongly the pulses show, from 0 to 1 as they fade in and out */
  private flow = 0;
  /** How far they have moved on, in seconds of the flights */
  private flowS = 0;
  /**
   * Whether they rest, for a map not used or under reduced motion, until
   * the map is used again
   */
  private resting = false;
  /** The exposure drawn with, which follows cloudExposure of the points */
  private exposure = 0;

  /**
   * `style` is asked on every frame, and draws nothing where it gives null;
   * `failed` is told when the shaders do not compile in the map's context
   */
  constructor(
    private readonly style: () => HeatCloudStyle | null,
    private readonly failed: (error: unknown) => void,
  ) {
    this.objects = new LayerGl(
      {
        owner: "the cloud's",
        vertex: VERTEX_SHADER,
        fragment: FRAGMENT_SHADER,
        attributes: ATTRIBUTES,
        uniforms: UNIFORMS,
        layout,
      },
      this.failed,
    );
  }

  /**
   * Draw the points `cloud` from the next frame on, or none: the frame
   * lets go of the ones it drew before (see LayerGl.empty)
   */
  setPoints(cloud: CloudPoints | null): void {
    this.cloud = cloud;
    this.usedAt = performance.now();
    this.resting = false;
    this.map?.triggerRepaint();
  }

  /**
   * The map is used: the pulses run again, from a frame on if they rest,
   * and so once reduced motion is turned off
   */
  private readonly wake = (): void => {
    // Not by the resizes of an export (see withMapStill)
    if (this.map && isMapStill(this.map)) return;
    this.usedAt = performance.now();
    if (!this.resting || prefersReducedMotion()) return;
    this.resting = false;
    this.map?.triggerRepaint();
  };

  onAdd(map: MapLibreMap): void {
    this.map = map;
    this.usedAt = performance.now();
    for (const type of CLOUD_FLOW_WAKE) map.on(type, this.wake);
  }

  onRemove(map: MapLibreMap, gl: WebGL2RenderingContext): void {
    this.map = null;
    for (const type of CLOUD_FLOW_WAKE) map.off(type, this.wake);
    this.objects.release(gl);
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const map = this.map;
    const cloud = this.cloud;
    this.drawn = 0;
    this.resting = false;
    // Without points, the ones of before go with the last of them (see
    // setPoints)
    if (!map || !cloud || cloud.count < 2) return this.objects.empty(gl);
    const style = this.style();
    if (!style || style.opacity <= 0) return;
    const ready = this.objects.begin(gl, options, cloud);
    if (!ready) return;

    const u = ready.program.uniforms;
    const center = map.getCenter();
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const ratio = map.getPixelRatio();
    const zoom = map.getZoom();
    const [mx, my] = mercatorOf([center.lat, center.lng]);
    const elevation = map.getCenterElevation();
    gl.uniform2f(u.u_viewport, width, height);
    const look = cloudLook(zoom);
    const sigma = look.sigmaPx * ratio;
    gl.uniform3f(
      u.u_sigma,
      sigma,
      CLOUD_SIGMA_FLOOR_PX,
      sigma * CLOUD_SIGMA_MOST,
    );
    setDepth(gl, u.u_depth, options, height);
    // The seconds of a cruise over a pixel at the middle: the heat is the
    // seconds of a stretch over its pixels
    const metresPerPixel = mercatorUnitMetres(center.lat) / (512 * 2 ** zoom);
    // The ground under a glow, for its pull: the plane through its point
    // and two a hundred pixels of the middle away, where the relief may be
    gl.uniform2f(
      u.u_ground,
      100 / (512 * 2 ** zoom),
      CLOUD_GROUND_SLACK_FT * style.groundM,
    );

    // The pulses and the exposure, eased from the last frame's. A frame
    // that took longer than 100 ms (a first one after a rest, or a busy
    // main thread) moves them on by that much: they slow for it rather
    // than jump. The period changing by the zoom needs nothing here: the
    // longer period of one octave is the shorter of the next, at the same
    // phase, and the blend between them is all on it where they meet.
    const now = performance.now();
    const seconds = Math.min(Math.max(now - this.drawnAt, 0), 100) / 1000;
    this.drawnAt = now;
    const step = seconds / CLOUD_FADE_S;
    const wanted = style.flow && !prefersReducedMotion();
    const awake = wanted && now - this.usedAt < CLOUD_FLOW_IDLE_MS;
    this.flow = wanted
      ? Math.min(Math.max(this.flow + (awake ? step : -step), 0), 1)
      : 0;
    const exposure = cloudExposure(cloud.busiest * look.gain);
    this.exposure = this.exposure
      ? this.exposure + (exposure - this.exposure) * Math.min(step * 4, 1)
      : exposure;
    // The seconds of the flights between two pulses, as a power of two and
    // the part of the way to the next: both are drawn, and blended
    const octave = Math.log2(
      (CLOUD_FLOW_SPACING_PX * metresPerPixel) / CLOUD_REFERENCE_SPEED_MS,
    );
    const period = 2 ** Math.floor(octave);
    this.flowS += (seconds * 2 ** octave) / CLOUD_FLOW_CYCLE_S;
    gl.uniform4f(
      u.u_flow,
      1 / period,
      0.5 / period,
      (this.flowS / period) % 1,
      (this.flowS / period / 2) % 1,
    );

    gl.uniform1f(u.u_until, style.until ?? 1e30);
    const fade = style.fade ?? 1;
    gl.uniform1f(
      u.u_gain,
      (fade * look.gain * this.exposure * CLOUD_REFERENCE_SPEED_MS * ratio) /
        metresPerPixel,
    );
    gl.bindVertexArray(ready.vao);
    drawing(gl);
    // The screen of the glows, towards white at full strength, and towards
    // as much of white as the cloud is drawn with when it is dimmed: every
    // glow on a pixel moves it that way, so however many there are it gets
    // no brighter than that, where a quarter of their heat, which it scaled
    // before, still filled the home field to white. The map under the
    // brightest of it goes the same way (see doc/development/heat.md). The
    // shadow's MAX takes no factors, and it is not drawn dimmed.
    const opacity = style.opacity;
    gl.blendColor(opacity, opacity, opacity, opacity);
    gl.blendFuncSeparate(
      gl.CONSTANT_COLOR,
      gl.ONE_MINUS_SRC_COLOR,
      gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA,
    );
    // The shadow on the ground, where the flights are lifted off it and the
    // cloud is not dimmed, the brightest of them kept; then the glow at
    // their heights, added up, and without its pulses while the map is
    // exported. The marks of the way flown show in the glow in place of
    // the pulses, and so in an exported image.
    this.pulses = isMapStill(map) ? 0 : this.flow;
    this.marks = markStrength(this.pulses, zoom);
    const passes = [
      [
        0,
        CLOUD_SHADOW_COLOUR,
        CLOUD_SHADOW_CEILING,
        0,
        gl.MAX,
        CLOUD_SHADOW_LIFT_FT,
        0,
      ],
      [
        style.liftM,
        CLOUD_COLOUR,
        1,
        this.pulses * CLOUD_FLOW_STRENGTH,
        gl.FUNC_ADD,
        [0, 0],
        this.marks,
      ],
    ] as const;
    const shadow = style.liftM > 0 && style.opacity >= 1;
    // Each pass in every world copy the view shows (see worldCopies), each
    // copy from its own origin and with the centre of the map from it: the
    // shadows of all copies before any glow, which a later shadow's MAX
    // would darken where copies overlap
    const copies = worldCopies(map, options, cloud.xs);
    for (const [
      liftM,
      colour,
      ceiling,
      pulses,
      blend,
      cast,
      marks,
    ] of passes.slice(shadow ? 0 : 1)) {
      gl.blendEquation(blend);
      gl.uniform3f(u.u_marks, marks, CLOUD_MARK_SPACING_PX * ratio, ratio);
      gl.uniform2f(u.u_heights, style.groundM, liftM);
      gl.uniform2f(u.u_shadow, cast[0], cast[1]);
      gl.uniform3f(u.u_colour, colour[0], colour[1], colour[2]);
      gl.uniform1f(u.u_ceiling, ceiling);
      gl.uniform2f(u.u_flowMix, octave - Math.floor(octave), pulses);
      for (const copy of copies) {
        const origin = [cloud.origin[0] + copy, cloud.origin[1]] as const;
        setProjection(gl, u, options, origin, center.lat);
        gl.uniform3f(u.u_centre, mx - origin[0], my - origin[1], elevation);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, cloud.count - 1);
      }
    }
    this.frames++;
    this.drawn = copies.length > 0 ? cloud.count - 1 : 0;
    // The next frame while the pulses run or fade, the exposure moves or
    // the cloud fades out, every one the screen shows so they move
    // smoothly; none at all once they rest, for the map or for reduced
    // motion
    this.resting = style.flow && !awake && !this.flow;
    if (
      awake ||
      this.flow > 0 ||
      fade < 1 ||
      Math.abs(this.exposure - exposure) > exposure / 100
    ) {
      map.triggerRepaint();
    }
  }
}
