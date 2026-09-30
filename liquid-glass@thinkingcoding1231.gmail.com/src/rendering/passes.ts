import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import type { Logger } from '../logger.js';

export class RenderPasses {
  // Per-pass pipeline copies; see pipeline().
  private _passPipelines = new Map<string, { base: Cogl.Pipeline; copy: Cogl.Pipeline }>();
  // Logs the UV mismatch in composite() only once.
  private _uvMismatchWarned = false;

  constructor(private _logger?: Logger) {}

  clear(): void {
    this._passPipelines.clear();
  }

  /**
   * A copy of `base` for one pass. Paint nodes run after vfunc_paint_target()
   * returns, so passes sharing a pipeline would all draw with the last pass's
   * uniforms. Copies are copy-on-write and are replaced only when `base` is
   * (a shader recompile). Blending is plain replace: a LayerNode does not
   * clear, and every pass covers its whole target.
   */
  pipeline(key: string, base: Cogl.Pipeline): Cogl.Pipeline {
    const cached = this._passPipelines.get(key);
    if (cached && cached.base === base) return cached.copy;

    const copy = base.copy();
    copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
    this._passPipelines.set(key, { base, copy });
    return copy;
  }

  /**
   * Queues a render-to-texture pass as a paint node. vfunc_paint_target()
   * runs while the node tree is built, before the offscreen capture is drawn;
   * immediate drawing would sample the previous frame's capture. As a child
   * of the effect's node, the pass runs after the capture. The projection is
   * framebuffer state, so setting it at build time is fine.
   */
  add(
    parentNode: any, targetFbo: any, pipeline: Cogl.Pipeline,
    destW: number, destH: number, uv: number[]
  ): void {
    (targetFbo as unknown as Cogl.Framebuffer).orthographic(0, 0, destW, destH, -1, 1);

    const layerNode = Clutter.LayerNode.new_to_framebuffer(targetFbo, pipeline);
    parentNode.add_child(layerNode);

    const drawNode = Clutter.PipelineNode.new(pipeline);
    layerNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: 0, y1: 0, x2: destW, y2: destH }),
      uv[0], uv[1], uv[2], uv[3]
    );
  }

  /**
   * Queues the final composite as a paint node, after the capture and the
   * blur passes. Both layers share one UV range (the crop pass guarantees
   * it), because add_multitexture_rectangle()'s introspection is broken and
   * crashes the shell.
   */
  composite(
    parentNode: any, pipeline: Cogl.Pipeline, dest: number[], layer0UV: number[], layer1UV: number[]
  ): void {
    if (layer0UV[0] !== layer1UV[0] || layer0UV[1] !== layer1UV[1] ||
      layer0UV[2] !== layer1UV[2] || layer0UV[3] !== layer1UV[3]) {
      if (!this._uvMismatchWarned) {
        this._uvMismatchWarned = true;
        this._logger?.error(
          '[Liquid Glass] composite layers disagree on UV range ' +
          `(layer0=[${layer0UV}] layer1=[${layer1UV}]); drawing with layer 0's range. ` +
          'This means the crop pass did not run when it was needed.'
        );
      }
    }

    const drawNode = Clutter.PipelineNode.new(pipeline);
    parentNode.add_child(drawNode);
    drawNode.add_texture_rectangle(
      new Clutter.ActorBox({ x1: dest[0], y1: dest[1], x2: dest[2], y2: dest[3] }),
      layer0UV[0], layer0UV[1], layer0UV[2], layer0UV[3]
    );
  }
}

// Cogl caches uniform locations, so these are cheap to call every frame.
export function setPipelineVec2(
  pipeline: Cogl.Pipeline, name: string, x: number, y: number
): void {
  const loc = pipeline.get_uniform_location(name);
  pipeline.set_uniform_float(loc, 2, 1, [x, y]);
}

export function setPipelineFloat(
  pipeline: Cogl.Pipeline, name: string, value: number
): void {
  const loc = pipeline.get_uniform_location(name);
  pipeline.set_uniform_float(loc, 1, 1, [value]);
}
