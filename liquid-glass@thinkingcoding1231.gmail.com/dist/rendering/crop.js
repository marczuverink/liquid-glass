import Cogl from 'gi://Cogl';
export class CropPass {
    _pipelines;
    _passes;
    _logger;
    constructor(_pipelines, _passes, _logger) {
        this._pipelines = _pipelines;
        this._passes = _passes;
        this._logger = _logger;
    }
    _cropTexture = null;
    _cropFbo = null;
    _cropPoolW = 0;
    _cropPoolH = 0;
    _ensureCropTarget(ctx, w, h) {
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
        }
        catch (e) {
            this._logger?.error(`[Liquid Glass] Failed to create crop texture (${w}x${h}): ${e}`);
            return false;
        }
    }
    render(parentNode, ctx, srcTex, srcW, srcH, allocW, allocH, uv) {
        if (allocW === srcW && allocH === srcH)
            return srcTex;
        if (!this._pipelines.passthrough)
            return srcTex;
        if (!this._ensureCropTarget(ctx, allocW, allocH))
            return srcTex;
        const pipeline = this._passes.pipeline('crop', this._pipelines.passthrough);
        pipeline.set_layer_texture(0, srcTex);
        this._passes.add(parentNode, this._cropFbo, pipeline, allocW, allocH, uv);
        return this._cropTexture;
    }
    clear() {
        this._cropTexture = null;
        this._cropFbo = null;
        this._cropPoolW = 0;
        this._cropPoolH = 0;
    }
}
