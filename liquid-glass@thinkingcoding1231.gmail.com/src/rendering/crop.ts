import Cogl from 'gi://Cogl';
import type { Logger } from '../logger.js';
import type { ShaderPipelines } from './pipelines.js';
import type { RenderPasses } from './passes.js';

export class CropPass {
  constructor(private _pipelines: ShaderPipelines, private _passes: RenderPasses, private _logger?: Logger) {}

  private _cropTexture: Cogl.Texture2D | null = null;

  private _cropFbo: Cogl.Offscreen | null = null;

  private _cropPoolW: number = 0;

  private _cropPoolH: number = 0;

  private _ensureCropTarget(ctx: Cogl.Context, w: number, h: number): boolean {
    if (this._cropTexture && this._cropFbo &&
      this._cropPoolW === w && this._cropPoolH === h) {
      return true;
    }

    this._cropTexture = null;
    this._cropFbo = null;
    this._cropPoolW = 0;
    this._cropPoolH = 0;

    try {
      const tex = Cogl.Texture2D.new_with_size(ctx, w, h);
      const fbo = Cogl.Offscreen.new_with_texture(tex);
      this._cropTexture = tex;
      this._cropFbo = fbo;
      this._cropPoolW = w;
      this._cropPoolH = h;
      return true;
    } catch (e) {
      this._logger?.error(`[Liquid Glass] Failed to create crop texture (${w}x${h}): ${e}`);
      return false;
    }
  }

  render(
    parentNode: any, ctx: Cogl.Context, srcTex: Cogl.Texture,
    srcW: number, srcH: number, allocW: number, allocH: number, uv: number[]
  ): Cogl.Texture {
    if (allocW === srcW && allocH === srcH) return srcTex;
    if (!this._pipelines.passthrough) return srcTex;
    if (!this._ensureCropTarget(ctx, allocW, allocH)) return srcTex;

    const pipeline = this._passes.pipeline('crop', this._pipelines.passthrough);
    pipeline.set_layer_texture(0, srcTex);

    this._passes.add(parentNode, this._cropFbo, pipeline, allocW, allocH, uv);
    return this._cropTexture!;
  }

  clear(): void {
    this._cropTexture = null;
    this._cropFbo = null;
    this._cropPoolW = 0;
    this._cropPoolH = 0;
  }
}
