import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import type { Logger } from '../logger.js';
import { splitShader } from './shaderSource.js';

export class ShaderPipelines {
  constructor(private _logger?: Logger) {}

  async load(extensionPath: string | undefined): Promise<void> {
    if (!extensionPath) throw new Error('Missing extension path for shader loading');
    this._downsampleSource = await this._readFileAsync(extensionPath + '/shaders/downsample.frag');
    this._upsampleSource = await this._readFileAsync(extensionPath + '/shaders/upsample.frag');
    this._glassSource = await this._readFileAsync(extensionPath + '/shaders/glass.frag');
  }

  clear(): void {
    this.downsample = null;
    this.upsample = null;
    this.composite = null;
    this.passthrough = null;
    this.boxDown = null;
  }

  public downsample: Cogl.Pipeline | null = null;

  public upsample: Cogl.Pipeline | null = null;
  public composite: Cogl.Pipeline | null = null;

  public passthrough: Cogl.Pipeline | null = null;

  public boxDown: Cogl.Pipeline | null = null;

  private _downsampleSource: string | null = null;

  private _upsampleSource: string | null = null;

  private _glassSource: string | null = null;

  private _readFileAsync(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = Gio.File.new_for_path(path);
      file.load_contents_async(null, (_, res) => {
        try {
          const [ok, bytes] = file.load_contents_finish(res);
          if (!ok) {
            reject(new Error(`load_contents_finish returned false for ${path}`));
          } else {
            resolve(new TextDecoder('utf-8').decode(bytes));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  initialize(ctx: Cogl.Context): void {
    this.downsample = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.downsample, 0);

    if (this._downsampleSource) {
      const downSnippet = splitShader(this._downsampleSource, message => this._logger?.warn(message));
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, downSnippet.decl, null);
      s.set_replace(downSnippet.body);
      this.downsample.add_snippet(s);
    }

    this.upsample = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.upsample, 0);

    if (this._upsampleSource) {
      const upSnippet = splitShader(this._upsampleSource, message => this._logger?.warn(message));
      const s = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, upSnippet.decl, null);
      s.set_replace(upSnippet.body);
      this.upsample.add_snippet(s);
    }
    this.passthrough = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.passthrough, 0);

    this.boxDown = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.boxDown, 0);
    {
      const boxSnip = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT,
        'uniform vec2 inv_size;\n', null);
      boxSnip.set_replace(
        'vec2 uv = cogl_tex_coord_in[0].st;\n' +
        'vec4 c  = texture2D(cogl_sampler0, uv + vec2( 1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2( 1.0, -1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0,  1.0) * inv_size);\n' +
        'c += texture2D(cogl_sampler0, uv + vec2(-1.0, -1.0) * inv_size);\n' +
        'cogl_color_out = c * 0.25;\n');
      this.boxDown.add_snippet(boxSnip);
    }

    this.composite = Cogl.Pipeline.new(ctx);
    configureSamplerLayer(this.composite, 0);

    this.composite.set_blend(
      'RGBA = ADD(SRC_COLOR, DST_COLOR * (1 - SRC_COLOR[A]))',
    );

    this._loadCompositeShader();
  }

  private _loadCompositeShader(): void {
    if (!this.composite || !this._glassSource) return;

    let { decl, body } = splitShader(this._glassSource, message => this._logger?.warn(message));

    decl = decl.replace(/uniform\s+sampler2D\s+cogl_sampler\d*\s*;[^\n]*/g, '');
    body = body.replace(/\bcogl_sampler\b/g, 'cogl_sampler0');

    const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, decl, null);
    snippet.set_replace(body);
    this.composite.add_snippet(snippet);
  }
}

export function configureSamplerLayer(pipeline: Cogl.Pipeline, layer: number): void {
  pipeline.set_layer_wrap_mode(layer, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
  pipeline.set_layer_filters(
    layer,
    Cogl.PipelineFilter.LINEAR,
    Cogl.PipelineFilter.LINEAR
  );
}
