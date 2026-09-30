import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import { getTransformedRect } from './actors/geometry.js';
import { utilsLog } from './diagnostics/logging.js';
// How much better the other colour has to score before the decision flips.
// With a preferred colour set, flipping towards it is easy and away from it
// hard.
const SWITCH_ADVANTAGE = 1.2;
const SWITCH_ADVANTAGE_TOWARD_PREFERRED = 1.02;
const SWITCH_ADVANTAGE_AGAINST_PREFERRED = 1.6;
// Contrast ratios this close mean the background favours neither colour; a
// preferred colour then applies outright (see decideTextColor()).
const AMBIGUOUS_RATIO = 1.15;
// Measurements are ignored this long after a flip: the samples cover the text
// itself, and the colour tween (about 380ms) would be measured as a change.
const SWITCH_SETTLE_MS = 600;
const MIN_READABLE_CONTRAST = 4.5;
const BACKDROP_COVERS_GLASS_ALPHA = 190;
const READABILITY_FLIP_COOLDOWN = 3;
const BACKGROUND_REALLY_MOVED = 0.15;
const BACKDROP_SEARCH_DEPTH = 8;
export const AdaptiveContrastConfig = {
    enabled: true,
    // Sample each text actor separately instead of one merged rect (costlier).
    samplePerElement: false,
    sampleIntervalMs: 200,
    lightTextColor: '#f2f2f2',
    darkTextColor: '#1a1a1a',
    // 'light'/'dark' name the text colour to favour; 'auto' favours neither.
    preference: 'auto',
};

// Anything unrecognised in the setting counts as 'auto'.
export function sanitizeColorPreference(value) {
    return (value === 'light' || value === 'dark') ? value : 'auto';
}

function _clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
}

function _srgbToLinear(c) {
    const n = c / 255.0;
    if (n <= 0.04045)
        return n / 12.92;
    return Math.pow((n + 0.055) / 1.055, 2.4);
}

function _luminanceFromRgb(r, g, b) {
    const rl = _srgbToLinear(r);
    const gl = _srgbToLinear(g);
    const bl = _srgbToLinear(b);
    return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function _trimmedMean(values, trimRatio = 0.1) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * trimRatio);
    const start = _clamp(trim, 0, sorted.length - 1);
    const end = _clamp(sorted.length - trim, start + 1, sorted.length);
    let sum = 0.0;
    for (let i = start; i < end; i++)
        sum += sorted[i];
    return sum / (end - start);
}

function _getActorRect(actor) {
    if (!actor)
        return null;
    if (!actor.mapped)
        return null;
    const [x, y, w, h] = getTransformedRect(actor);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0)
        return null;
    // Shell.Screenshot expects stage coordinates, including ancestor scale.
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(global.stage.width, Math.ceil(x + w));
    const bottom = Math.min(global.stage.height, Math.ceil(y + h));
    if (right <= left || bottom <= top)
        return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
}

function _mergeRects(rects) {
    if (rects.length === 0)
        return null;
    let minX = rects[0].x;
    let minY = rects[0].y;
    let maxX = rects[0].x + rects[0].width;
    let maxY = rects[0].y + rects[0].height;
    for (let i = 1; i < rects.length; i++) {
        const r = rects[i];
        minX = Math.min(minX, r.x);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.width);
        maxY = Math.max(maxY, r.y + r.height);
    }
    return {
        x: minX,
        y: minY,
        width: Math.max(1, maxX - minX),
        height: Math.max(1, maxY - minY),
    };
}

// The samples come from Shell.Screenshot as a PNG in memory. A direct GPU
// read-back (Stage.paint_to_buffer(), Cogl.Texture.get_data()) is not usable
// from GJS: their output buffers are annotated as input arrays, so GJS passes
// a temporary copy and the pixels never come back.
let _capturePathLogged = false;

function _reportCapturePath(msg) {
    if (_capturePathLogged)
        return;
    _capturePathLogged = true;
    utilsLog(`[Liquid Glass][contrast] ${msg}`);
}

// Pixels are sampled on a grid of about this many steps per edge.
const SAMPLE_MAX_EDGE = 48;

/**
 * Captures a screen rectangle into memory, only to measure the brightness
 * behind the text. Nothing is written to disk or kept after the measurement.
 */
function _captureViaScreenshot(screenshot, rect) {
    return new Promise(resolve => {
        const stream = Gio.MemoryOutputStream.new_resizable();
        screenshot.screenshot_area(Math.floor(rect.x), Math.floor(rect.y), Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)), stream, (obj, res) => {
            // Both the finish call and the PNG decoder throw a GError on failure.
            try {
                const ok = obj.screenshot_area_finish(res)[0];
                stream.close(null);
                if (!ok) {
                    resolve(null);
                    return;
                }
                const bytes = stream.steal_as_bytes();
                const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
                if (!pixbuf) {
                    resolve(null);
                    return;
                }
                const width = pixbuf.get_width();
                const height = pixbuf.get_height();
                resolve({
                    data: pixbuf.get_pixels(),
                    width,
                    height,
                    stride: pixbuf.get_rowstride(),
                    channels: pixbuf.get_n_channels(),
                    step: Math.max(1, Math.floor(Math.min(width, height) / SAMPLE_MAX_EDGE)),
                });
            }
            catch {
                resolve(null);
            }
        });
    });
}

export function backdropLuminance(actor, root = null) {
    let node = actor;
    for (let depth = 0; node && depth < BACKDROP_SEARCH_DEPTH; depth++) {
        // Only St widgets have a theme node; plain Clutter actors are skipped.
        const color = node.get_theme_node?.().get_background_color();
        if (color && color.alpha >= BACKDROP_COVERS_GLASS_ALPHA) {
            return {
                luminance: _luminanceFromRgb(color.red, color.green, color.blue),
                alpha: color.alpha,
            };
        }
        if (root && node === root)
            break;
        node = node.get_parent();
    }
    return null;
}

function _visibleTargets(actors) {
    const targets = [];
    const rects = [];
    for (const actor of actors) {
        const rect = _getActorRect(actor);
        if (!rect)
            continue;
        targets.push(actor);
        rects.push(rect);
    }
    return { targets, rects };
}

function _rootOrMergedRect(root, rects) {
    const rootRect = root ? _getActorRect(root) : null;
    return rootRect ?? _mergeRects(rects);
}

function _readSignature(paintSignature) {
    if (!paintSignature)
        return null;
    const v = paintSignature();
    return Number.isFinite(v) ? v : null;
}

// The decision also depends on the configuration, not only on pixels.
function _skipKey(rects, config) {
    return rects
        .map(r => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`)
        .join(';') + `|${config.samplePerElement ? 'e' : 'm'}|${config.preference ?? 'auto'}|${config.lightTextColor}|${config.darkTextColor}`;
}

function _pixelLuminance(data, idx, channels) {
    if (channels <= 3)
        return _luminanceFromRgb(data[idx], data[idx + 1], data[idx + 2]);
    const a = data[idx + 3];
    if (a < 32)
        return null;
    if (a >= 255)
        return _luminanceFromRgb(data[idx], data[idx + 1], data[idx + 2]);
    // Un-premultiply semi-transparent pixels before measuring.
    const inv = 255.0 / a;
    const unpremultiply = (c) => _clamp(Math.round(c * inv), 0, 255);
    return _luminanceFromRgb(unpremultiply(data[idx]), unpremultiply(data[idx + 1]), unpremultiply(data[idx + 2]));
}

export function luminanceSamples(shot) {
    const { data, width, height, stride, channels, step } = shot;
    const values = [];
    for (let y = 0; y < height; y += step) {
        const row = y * stride;
        for (let x = 0; x < width; x += step) {
            const luma = _pixelLuminance(data, row + x * channels, channels);
            if (luma !== null)
                values.push(luma);
        }
    }
    return values;
}

export class StageContrastSampler {
    // Created on the first sample; many samplers are never used.
    _screenshot = null;
    _lastLuma = null;
    _lastIsBright = null;
    // Monotonic time of the last flip; see SWITCH_SETTLE_MS.
    _lastSwitchAt = null;
    // The configuration the hold started under; a change ends it.
    _holdConfig = '';
    _roundsSinceFlip = READABILITY_FLIP_COOLDOWN;
    _lastRawLuma = null;
    _lastRect = null;
    _lastDecided = null;
    // The caller's paint counter after the last capture, and the rects and
    // configuration it measured; see chooseColorsForActors().
    _unchangedSignature = null;
    _unchangedKey = '';

    // The next call always samples.
    invalidate() {
        this._unchangedSignature = null;
        this._unchangedKey = '';
    }

    async sampleLuminance(rect) {
        if (!rect || rect.width <= 0 || rect.height <= 0)
            return null;
        if (!this._screenshot)
            this._screenshot = new Shell.Screenshot();
        const shot = await _captureViaScreenshot(this._screenshot, rect);
        if (!shot) {
            _reportCapturePath('screenshot capture failed; adaptive text colors will keep their current values');
            return null;
        }
        const values = luminanceSamples(shot);
        if (values.length === 0) {
            _reportCapturePath('capture produced no usable pixels (everything below the alpha cutoff)');
            return null;
        }
        // The sampled rect contains the text itself, whose colour is what is
        // being decided. Trimming 30% from each end (an interquartile mean) keeps
        // the glyphs from moving the result, so a flip cannot flip itself back.
        return _trimmedMean(values, 0.30);
    }

    decideTextColor(luminance, config = AdaptiveContrastConfig) {
        if (luminance === null || luminance === undefined)
            return null;
        if (!Number.isFinite(luminance))
            return null;
        luminance = _clamp(luminance, 0, 1);
        const colorLuma = (hex) => {
            const rgb = parseInt(hex.slice(1), 16);
            return _luminanceFromRgb((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
        };
        const light = colorLuma(config.lightTextColor);
        const dark = colorLuma(config.darkTextColor);
        const contrast = (background, foreground) => (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
        const rawLight = contrast(luminance, light);
        const rawDark = contrast(luminance, dark);
        const preference = config.preference ?? 'auto';
        const hasPreference = preference !== 'auto';
        const preferDark = preference === 'dark';
        // From the raw contrasts, so it reflects what is on screen now.
        const ambiguous = Math.max(rawLight, rawDark) < Math.min(rawLight, rawDark) * AMBIGUOUS_RATIO;
        // Per-element decisions keep no history, so the preference is the only
        // stabiliser.
        if (config.samplePerElement) {
            if (ambiguous && hasPreference)
                return preferDark ? config.darkTextColor : config.lightTextColor;
            return rawDark > rawLight ? config.darkTextColor : config.lightTextColor;
        }
        // Hold the decision for SWITCH_SETTLE_MS after a flip, unless the held
        // colour is unreadable and the other one is not. A configuration change
        // ends the hold: it should apply at once.
        const now = GLib.get_monotonic_time();
        const holdConfig = `${preference}|${config.lightTextColor}|${config.darkTextColor}`;
        if (holdConfig !== this._holdConfig) {
            this._holdConfig = holdConfig;
            this._lastSwitchAt = null;
        }
        if (this._lastIsBright !== null && this._inSettleHold(now)) {
            const heldContrast = this._lastIsBright ? rawDark : rawLight;
            const otherContrast = this._lastIsBright ? rawLight : rawDark;
            const heldUnreadable = heldContrast < MIN_READABLE_CONTRAST && otherContrast >= MIN_READABLE_CONTRAST;
            if (!heldUnreadable)
                return this._lastIsBright ? config.darkTextColor : config.lightTextColor;
        }
        const smoothed = this._lastLuma === null
            ? luminance : this._lastLuma * 0.7 + luminance * 0.3;
        this._lastLuma = smoothed;
        const lightContrast = contrast(smoothed, light);
        const darkContrast = contrast(smoothed, dark);
        let isBright;
        if (ambiguous && hasPreference) {
            // Decided by the measurement alone, so it cannot oscillate.
            isBright = preferDark;
        }
        else if (this._lastIsBright === null) {
            // First decision for this surface.
            isBright = darkContrast > lightContrast;
        }
        else {
            isBright = this._lastIsBright;
            const current = isBright ? darkContrast : lightContrast;
            const alternative = isBright ? lightContrast : darkContrast;
            const towardPreferred = hasPreference && preferDark !== isBright;
            const advantage = !hasPreference ? SWITCH_ADVANTAGE
                : (towardPreferred ? SWITCH_ADVANTAGE_TOWARD_PREFERRED : SWITCH_ADVANTAGE_AGAINST_PREFERRED);
            if (alternative > current * advantage)
                isBright = !isBright;
        }
        // Readability wins over smoothing and over the preference: switch at once
        // when the current colour is unreadable and the other is not.
        const rawCurrent = isBright ? rawDark : rawLight;
        const rawAlternative = isBright ? rawLight : rawDark;
        const jumped = this._lastRawLuma === null ||
            Math.abs(luminance - this._lastRawLuma) > BACKGROUND_REALLY_MOVED;
        this._lastRawLuma = luminance;
        const wasBright = isBright;
        if (rawCurrent < MIN_READABLE_CONTRAST && rawAlternative >= MIN_READABLE_CONTRAST &&
            (jumped || this._roundsSinceFlip >= READABILITY_FLIP_COOLDOWN))
            isBright = !isBright;
        this._roundsSinceFlip = isBright === wasBright ? this._roundsSinceFlip + 1 : 0;
        if (this._lastIsBright !== null && this._lastIsBright !== isBright)
            this._lastSwitchAt = now;
        this._lastIsBright = isBright;
        return isBright ? config.darkTextColor : config.lightTextColor;
    }

    _inSettleHold(now = GLib.get_monotonic_time()) {
        return this._lastSwitchAt !== null && now - this._lastSwitchAt < SWITCH_SETTLE_MS * 1000;
    }

    _backdropColorFor(actor, config, root) {
        const backdrop = backdropLuminance(actor, root);
        if (backdrop === null)
            return null;
        return this.decideTextColor(backdrop.luminance, { ...config, samplePerElement: true });
    }

    /**
     * @param paintSignature Optional counter that advances whenever the glass
     *   under the text is painted. Anything that changes under the text
     *   repaints that glass, so while the counter stands still the capture is
     *   skipped and an empty map returned (the applied colours stay).
     */
    async chooseColorsForActors(actors, config = AdaptiveContrastConfig, root = null, paintSignature) {
        const { targets, rects } = _visibleTargets(actors);
        if (targets.length === 0)
            return new Map();
        const merged = config.samplePerElement ? null : _rootOrMergedRect(root, rects);
        const mergedRects = merged ? [merged] : [];
        const sampledRects = config.samplePerElement ? rects : mergedRects;
        const key = _skipKey(config.samplePerElement ? rects : [...sampledRects, ...rects], config);
        const before = _readSignature(paintSignature);
        if (before !== null && before === this._unchangedSignature && key === this._unchangedKey)
            return new Map();
        // Only a converged decision may be frozen: the merged path smooths over
        // samples and holds after a flip. The capture itself paints the region,
        // so it may advance the counter by one per screenshot; more means the
        // screen changed meanwhile.
        const settle = (stable) => {
            const after = _readSignature(paintSignature);
            if (stable && before !== null && after !== null && after - before <= sampledRects.length) {
                this._unchangedSignature = after;
                this._unchangedKey = key;
            }
            else {
                this.invalidate();
            }
        };
        if (config.samplePerElement)
            return this._choosePerElement(targets, rects, config, settle);
        if (!merged)
            return new Map();
        return this._chooseMerged(targets, merged, config, settle);
    }

    _resetIfRegionMoved(merged) {
        const last = this._lastRect;
        const moved = !last || ['x', 'y', 'width', 'height'].some(k => Math.abs(merged[k] - last[k]) > 2);
        if (moved) {
            this._lastLuma = null;
            this._lastIsBright = null;
            this._lastRawLuma = null;
            this._lastSwitchAt = null;
            this._roundsSinceFlip = READABILITY_FLIP_COOLDOWN;
        }
        this._lastRect = merged;
    }

    async _chooseMerged(targets, merged, config, settle) {
        const result = new Map();
        this._resetIfRegionMoved(merged);
        const luma = await this.sampleLuminance(merged);
        if (luma === null) {
            this.invalidate();
            return result;
        }
        const inHold = this._lastIsBright !== null && this._inSettleHold();
        const color = this.decideTextColor(luma, config);
        const converged = this._lastLuma !== null && Math.abs(this._lastLuma - _clamp(luma, 0, 1)) < 0.01;
        settle(!inHold && color !== null && color === this._lastDecided && converged &&
            this._roundsSinceFlip >= READABILITY_FLIP_COOLDOWN);
        this._lastDecided = color;
        if (color)
            for (const actor of targets)
                result.set(actor, color);
        return result;
    }

    async _choosePerElement(targets, rects, config, settle) {
        const result = new Map();
        for (let i = 0; i < targets.length; i++) {
            const luma = await this.sampleLuminance(rects[i]);
            if (luma === null) {
                this.invalidate();
                return result;
            }
            const color = this.decideTextColor(luma, config);
            if (color)
                result.set(targets[i], color);
        }
        // Per-element decisions are stateless.
        settle(true);
        return result;
    }
}
