import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
export const InverseCornerEffect = GObject.registerClass({
    GTypeName: 'LiquidGlassInverseCornerEffect',
}, class InverseCornerEffect extends Clutter.ShaderEffect {
    _radius = 0;
    _inset = 0;
    _glassRadius = 0;
    setRadius(radius) {
        this._radius = radius;
        this._updateShader();
    }
    setGlassRadius(radius) {
        this._glassRadius = radius;
        this._updateShader();
    }
    setInset(inset) {
        this._inset = inset;
        this._updateShader();
    }
    _updateShader() {
        const shader = `
        uniform sampler2D cogl_sampler;
        uniform float radius;
        uniform float glass_radius;
        uniform float inset;
        uniform float width;
        uniform float height;

        float sdRoundRect(vec2 p, vec2 b, float r) {
          vec2 d = abs(p) - b + vec2(r);
          return min(max(d.x, d.y), 0.0) + length(max(d, 0.0)) - r;
        }

        void main() {
          vec2 st = cogl_tex_coord_in[0].st;
          vec2 resolution = vec2(width, height);
          vec2 p = (st * resolution) - (resolution * 0.5);

          vec2 windowHalf = max(resolution * 0.5 - vec2(inset), vec2(1.0));

          float dCut = sdRoundRect(p, windowHalf, radius);
          float dGlass = sdRoundRect(p, windowHalf, max(glass_radius, 0.0));

          float alpha = smoothstep(-0.5, 0.5, dCut);

          alpha *= 1.0 - smoothstep(-0.5, 0.5, dGlass - 1.5);

          alpha *= smoothstep(0.15, 0.6, dCut - dGlass);

          vec2 edgeDist = min(st, 1.0 - st) * resolution;
          float edgeFade = smoothstep(0.0, 10.0, min(edgeDist.x, edgeDist.y));
          alpha *= edgeFade;

          cogl_color_out = texture2D(cogl_sampler, st) * alpha * cogl_color_in;
        }
      `;
        this.set_shader_source(shader);
        this._updateUniforms();
    }
    _setUniform(name, value) {
        let gval = new GObject.Value();
        gval.init(GObject.TYPE_FLOAT);
        gval.set_float(value);
        this.set_uniform_value(name, gval);
    }
    _updateUniforms() {
        let actor = this.get_actor();
        if (!actor)
            return;
        let w = actor.width;
        let h = actor.height;
        if (Number.isNaN(w) || Number.isNaN(h) || w <= 0 || h <= 0)
            return;
        this._setUniform('radius', this._radius);
        this._setUniform('glass_radius', this._glassRadius);
        this._setUniform('inset', this._inset);
        this._setUniform('width', w);
        this._setUniform('height', h);
    }
    vfunc_paint_target(node, paint_context) {
        this._updateUniforms();
        super.vfunc_paint_target(node, paint_context);
    }
});
