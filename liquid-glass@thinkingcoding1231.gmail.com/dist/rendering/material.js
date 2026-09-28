export class MaterialSettings {
    _settings;
    _uniforms;
    _blur;
    _setDiagnostics;
    _settingsIds = [];
    constructor(_settings, _uniforms, _blur, _setDiagnostics) {
        this._settings = _settings;
        this._uniforms = _uniforms;
        this._blur = _blur;
        this._setDiagnostics = _setDiagnostics;
    }
    initialize() {
        this._uniforms.set('resolution_x', 0.0);
        this._uniforms.set('resolution_y', 0.0);
        this._uniforms.set('pointer_x', -100.0);
        this._uniforms.set('pointer_y', -100.0);
        this._uniforms.set('intensity', 0.0);
        this._uniforms.set('corner_radius', 60.0);
        this._uniforms.set('brightness', 1.0);
        this._uniforms.set('contrast', 1.0);
        this._uniforms.set('saturation', 1.0);
        this._uniforms.set('padding', 20.0);
        this._uniforms.set('shadow_max_radius', 180.0);
        this._uniforms.set('isDock', 0.0);
        this._uniforms.set('surface_light_enabled', 1.0);
        this._uniforms.set('dock_x', 0.0);
        this._uniforms.set('dock_y', 0.0);
        this._uniforms.set('dock_w', 0.0);
        this._uniforms.set('dock_h', 0.0);
        this._uniforms.set('multi_region_mode', 0.0);
        this._uniforms.set('region_count', 0.0);
        this._uniforms.set('early_exit_enabled', 1.0);
        this._uniforms.set('debug_view', 0.0);
        this._uniforms.set('blur_rect_x', 0.0);
        this._uniforms.set('blur_rect_y', 0.0);
        this._uniforms.set('blur_rect_w', 0.0);
        this._uniforms.set('blur_rect_h', 0.0);
        this._settingsIds = [];
        if (this._settings) {
            this._bindSettings();
        }
        else {
            this._uniforms.set('max_z', 25.0);
            this._uniforms.set('displacement_scale', 78.5);
            this._uniforms.set('edge_smoothing', 2.0);
            this._uniforms.set('profile_shape_n', 7.0);
            this._uniforms.set('ior', 2.40);
            this._uniforms.set('chroma_strength', 0.006);
            this._uniforms.set('specular_intensity', 0.0);
            this._uniforms.set('shininess', 42.0);
            this._uniforms.set('rim_width', 5.0);
            this._uniforms.set('rim_intensity', 0.6);
            this._uniforms.set('rim_directional_power', 2.7);
            this._uniforms.set('rim_power', 6.0);
            this._uniforms.set('rim_light_color_intensity', 1.4);
            this._uniforms.set('sheen_intensity', 0.32);
            this._uniforms.set('light_angle_deg', 0.0);
            this._uniforms.set('shadow_radius', 8.0);
            this._uniforms.set('shadow_intensity', 0.55);
            this._uniforms.set('ao_intensity', 0.25);
            this._uniforms.set('ao_radius', 7.5);
            this._uniforms.set('tint_strength', 0.0);
            this._uniforms.set('tint_r', 1.0);
            this._uniforms.set('tint_g', 1.0);
            this._uniforms.set('tint_b', 1.0);
        }
    }
    clear() {
        if (this._settings)
            this._settingsIds.forEach(id => this._settings?.disconnect(id));
        this._settingsIds = [];
    }
    _bindSettings() {
        const mappings = [
            { key: 'glass-max-z', uniform: 'max_z' },
            { key: 'glass-displacement-scale', uniform: 'displacement_scale' },
            { key: 'glass-edge-smoothing', uniform: 'edge_smoothing' },
            { key: 'glass-profile-shape-n', uniform: 'profile_shape_n' },
            { key: 'glass-ior', uniform: 'ior' },
            { key: 'glass-chroma-strength', uniform: 'chroma_strength' },
            { key: 'glass-specular-intensity', uniform: 'specular_intensity' },
            { key: 'glass-shininess', uniform: 'shininess' },
            { key: 'glass-rim-width', uniform: 'rim_width' },
            { key: 'glass-rim-intensity', uniform: 'rim_intensity' },
            { key: 'glass-rim-directional-power', uniform: 'rim_directional_power' },
            { key: 'glass-rim-power', uniform: 'rim_power' },
            { key: 'glass-rim-light-color-intensity', uniform: 'rim_light_color_intensity' },
            { key: 'glass-sheen-intensity', uniform: 'sheen_intensity' },
            { key: 'glass-light-angle-deg', uniform: 'light_angle_deg' },
            { key: 'shadow-radius', uniform: 'shadow_radius' },
            { key: 'shadow-intensity', uniform: 'shadow_intensity' },
            { key: 'glass-ao-intensity', uniform: 'ao_intensity' },
            { key: 'glass-ao-radius', uniform: 'ao_radius' },
        ];
        const settings = this._settings;
        if (!settings)
            return;
        mappings.forEach(map => {
            this._uniforms.set(map.uniform, settings.get_double(map.key));
            const id = settings.connect(`changed::${map.key}`, () => {
                this._uniforms.set(map.uniform, settings.get_double(map.key));
            });
            this._settingsIds.push(id);
        });
        const applyDownscale = () => {
            const factor = settings.get_int('glass-blur-downscale') >= 4 ? 4 : 2;
            this._blur.setDownscale(factor);
        };
        applyDownscale();
        const downscaleId = settings.connect('changed::glass-blur-downscale', applyDownscale);
        this._settingsIds.push(downscaleId);
        const applyBlurMethod = () => {
            const raw = settings.get_int('blur-method');
            this._blur.setBlurMethod(raw === 0 ? 0 : 1);
        };
        applyBlurMethod();
        const blurMethodId = settings.connect('changed::blur-method', applyBlurMethod);
        this._settingsIds.push(blurMethodId);
        const applyDiagFlag = () => {
            this._setDiagnostics(settings.get_boolean('glass-debug-diagnostics'));
        };
        applyDiagFlag();
        const diagId = settings.connect('changed::glass-debug-diagnostics', applyDiagFlag);
        this._settingsIds.push(diagId);
    }
    setAnimationScale(scale) {
        const settings = this._settings;
        if (!settings)
            return false;
        this._uniforms.set('displacement_scale', settings.get_double('glass-displacement-scale') * scale);
        this._uniforms.set('max_z', settings.get_double('glass-max-z') * scale);
        this._uniforms.set('chroma_strength', settings.get_double('glass-chroma-strength') * scale);
        return true;
    }
}
