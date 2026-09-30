import Cogl from 'gi://Cogl';

export class CropPass {
    _pipelines;
    _passes;

    constructor(_pipelines, _passes) {
        this._pipelines = _pipelines;
        this._passes = _passes;
    }

    _cropTexture = null;
    _cropFbo = null;
    _cropPoolW = 0;
    _cropPoolH = 0;

    _ensureCropTarget(ctx, w, h) {
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
    render(parentNode, ctx, srcTex, srcW, srcH, allocW, allocH, uv) {
        if (allocW === srcW && allocH === srcH)
            return srcTex;
        if (!this._pipelines.passthrough)
            return srcTex;
        this._ensureCropTarget(ctx, allocW, allocH);
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
