import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import type { Logger } from '../logger.js';

export class RenderPasses {
  private _passPipelines = new Map<string, { base: Cogl.Pipeline; copy: Cogl.Pipeline }>();
  private _uvMismatchWarned = false;

  constructor(private _logger?: Logger) {}

  clear(): void {
    this._passPipelines.clear();
  }

  pipeline(key: string, base: Cogl.Pipeline): Cogl.Pipeline {
    const cached = this._passPipelines.get(key);
    if (cached && cached.base === base) return cached.copy;

    const copy = base.copy();
    try {
      copy.set_blend('RGBA = ADD(SRC_COLOR, 0)');
    } catch (e) {
      this._logger?.error(`[Liquid Glass] set_blend failed for pass '${key}': ${e}`);
    }
    this._passPipelines.set(key, { base, copy });
    return copy;
  }

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
