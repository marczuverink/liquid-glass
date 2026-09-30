import Cogl from 'gi://Cogl';
import type { ShaderPipelines } from './pipelines.js';
import type { RenderPasses } from './passes.js';

export class CropPass {
  constructor(private _pipelines: ShaderPipelines, private _passes: RenderPasses) {}

  private _cropTexture: Cogl.Texture2D | null = null;

  private _cropFbo: Cogl.Offscreen | null = null;

  private _cropPoolW: number = 0;

  private _cropPoolH: number = 0;

  private _ensureCropTarget(ctx: Cogl.Context, w: number, h: number): void {
    if (this._cropTexture && this._cropFbo &&
      this._cropPoolW === w && this._cropPoolH === h)
      return;

    this._cropTexture = Cogl.Texture2D.new_with_size(ctx, w, h);
    this._cropFbo = Cogl.Offscreen.new_with_texture(this._cropTexture);
    this._cropPoolW = w;
    this._cropPoolH = h;
  }

  /**
   * Copies the actor's own pixels out of the padded capture into a
   * padding-free texture, as a paint node like every other pass. The blur
   * input and both composite layers can then use the plain 0..1 UV range,
   * since add_multitexture_rectangle() cannot be used from GJS (see
   * RenderPasses.composite()). Costs one full-resolution pass.
   */
  render(
    parentNode: any, ctx: Cogl.Context, srcTex: Cogl.Texture,
    srcW: number, srcH: number, allocW: number, allocH: number, uv: number[]
  ): Cogl.Texture {
    if (allocW === srcW && allocH === srcH) return srcTex;
    if (!this._pipelines.passthrough) return srcTex;
    this._ensureCropTarget(ctx, allocW, allocH);

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
