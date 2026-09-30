import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import { getAllocatedSize, computeCaptureLayout } from './geometry.js';
/**
 * Paints another OffscreenEffect's texture stretched over its allocation.
 * Unlike a Clutter.Clone it never paints the source, so the source's effect
 * does not run a second time (see UILayerSampler._createExistingEffectBlitActor).
 */
export const TextureBlitActor = GObject.registerClass({
    GTypeName: 'LiquidGlassTextureBlitActor',
}, class TextureBlitActor extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
        this._getTexture = null;
        this._sourceActor = null;
        this._pipeline = null;
    }
    vfunc_pick(_pickContext) { }
    setTextureGetter(fn) {
        this._getTexture = fn;
    }
    setSourceActor(actor) {
        this._sourceActor = actor;
    }
    _getCoglContext() {
        return Clutter.get_default_backend().get_cogl_context();
    }
    _textureUV(tex) {
        const texW = tex.get_width();
        const texH = tex.get_height();
        // The captured texture is padded unevenly around the actor (see
        // computeCaptureLayout()); sample only the source's own pixels.
        let uMin = 0, vMin = 0, uMax = 1, vMax = 1;
        const src = this._sourceActor;
        if (src) {
            const [rawW, rawH] = getAllocatedSize(src);
            const allocW = Number.isFinite(rawW) && rawW > 0 ? Math.round(rawW) : texW;
            const allocH = Number.isFinite(rawH) && rawH > 0 ? Math.round(rawH) : texH;
            if ((allocW !== texW || allocH !== texH) && texW > 0 && texH > 0) {
                const uv = computeCaptureLayout(src, texW, texH, allocW, allocH).uv;
                uMin = uv[0];
                vMin = uv[1];
                uMax = uv[2];
                vMax = uv[3];
            }
        }
        return [uMin, vMin, uMax, vMax];
    }
    vfunc_paint(paintContext) {
        if (!this._getTexture)
            return;
        const tex = this._getTexture();
        if (!tex)
            return;
        if (!this._pipeline) {
            this._pipeline = Cogl.Pipeline.new(this._getCoglContext());
            this._pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
            this._pipeline.set_layer_filters(0, Cogl.PipelineFilter.LINEAR, Cogl.PipelineFilter.LINEAR);
        }
        const [uMin, vMin, uMax, vMax] = this._textureUV(tex);
        this._pipeline.set_layer_texture(0, tex);
        const [w, h] = this.get_size();
        if (!(w > 0) || !(h > 0))
            return;
        const fb = paintContext.get_framebuffer();
        fb.draw_textured_rectangle(this._pipeline, 0, 0, w, h, uMin, vMin, uMax, vMax);
    }
});
