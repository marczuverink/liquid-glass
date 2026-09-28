import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import { getTransformedRect } from './actors/geometry.js';
// How much better the OTHER colour has to score before the decision flips.
// Only used when no preference is set ('auto'); with a preference the two
// directions get their own, deliberately asymmetric thresholds below.
const SWITCH_ADVANTAGE = 1.2;
// Flipping TOWARDS the user's preferred colour barely needs an excuse ...
const SWITCH_ADVANTAGE_TOWARD_PREFERRED = 1.02;
// ... flipping AWAY from it needs a decisive one.
const SWITCH_ADVANTAGE_AGAINST_PREFERRED = 1.6;
// Contrast ratios this close to each other mean the background genuinely does
// not favour either colour. See decideTextColor(): in that band a configured
// preference is applied outright ("断定してしまう") instead of letting the
// measurement decide, which is what the ping-ponging came from.
const AMBIGUOUS_RATIO = 1.15;
// After the decision flips, ignore every measurement for this long. The colour
// tween takes ~380ms and the sampler photographs the screen area the text
// itself is drawn on, so samples taken during the tween are measuring our own
// half-finished colour change. See the feedback-loop note on sampleLuminance().
const SWITCH_SETTLE_MS = 600;
const MIN_READABLE_CONTRAST = 4.5;
const BACKDROP_COVERS_GLASS_ALPHA = 190;
const READABILITY_FLIP_COOLDOWN = 3;
const BACKGROUND_REALLY_MOVED = 0.15;
const BACKDROP_SEARCH_DEPTH = 8;
export const AdaptiveContrastConfig = {
    enabled: true,
    samplePerElement: false, // 要素ごとにサンプリングするか、全体をまとめてサンプリングするか　負荷を考慮してデフォルトはまとめてサンプリング
    sampleIntervalMs: 200, // 5Hz
    lightTextColor: '#f2f2f2',
    darkTextColor: '#1a1a1a',
    // 'auto' keeps the previous behaviour exactly (symmetric hysteresis, no
    // snapping). 'light'/'dark' name the TEXT colour to favour.
    preference: 'auto',
};
/**
 * Narrows a raw GSettings string to an AdaptiveColorPreference. Anything
 * unrecognised (an older/newer schema, a hand-edited dconf value) falls back
 * to 'auto', which is the behaviour that existed before the setting did.
 */
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
// [PERF] Why this does NOT read the GPU back directly.
//
// The obvious implementation is clutter_stage_paint_to_buffer(): render the
// sampled rectangle straight into a small buffer, no codec and no file. It
// was implemented, measured on GNOME 50 / GJS, and it does not work — the
// buffer comes back untouched:
//
//   [Liquid Glass][contrast] stage.paint_to_buffer() left the buffer
//   untouched — GJS marshalled it as an input copy
//
// The reason is the introspection annotation. In mutter 50.1,
// clutter-stage.c declares the destination as
//
//     @data: (array) (element-type guint8): a pointer to the data
//
// with no direction, which means "in". GJS is free to marshal an input array
// as a temporary copy, which is exactly what it does here, so the pixels are
// written into that copy and freed. The same applies to the other candidate,
// cogl_texture_get_data(), whose cogl-texture.h annotation is
//
//     @data: (array) (nullable): memory location to write the texture's
//
// — also plain "in". So there is no GPU read-back path reachable from GJS in
// this stack, and the code that tried one has been removed rather than left
// in as a branch that can never be taken. (memo.md 6.1 records the same
// class of problem from the other direction: an array argument mis-annotated
// as a scalar, which crashed the shell instead of failing quietly.)
//
// What is left is still a real improvement over the original: the PNG goes
// through a Gio.MemoryOutputStream instead of a file in /tmp, so the write,
// the read back and the unlink are gone. If a future mutter adds
// (out caller-allocates) to either annotation, paint_to_buffer becomes worth
// revisiting — see performance-plan.md.
let _capturePathLogged = false;
function _reportCapturePath(msg) {
    if (_capturePathLogged)
        return;
    _capturePathLogged = true;
    console.log(`[Liquid Glass][contrast] ${msg}`);
}
// Longest edge sampled from the captured image. The original code walked the
// full-resolution pixels with `step = max(1, min(w, h) / 48)`, i.e. it
// already reduced everything to a ~48x48 grid before averaging; keeping that
// number keeps the measurement identical.
const SAMPLE_MAX_EDGE = 48;
/**
 * Captures one rectangle of the screen via Shell.Screenshot, into memory.
 *
 * Still pays for a full-resolution render and a PNG round trip — see the
 * comment above for why a direct read-back is not available — but through a
 * Gio.MemoryOutputStream rather than /tmp, so the file write, the file read
 * and the unlink the original did five times a second are gone.
 */
function _captureViaScreenshot(screenshot, rect) {
    return new Promise(resolve => {
        try {
            const stream = Gio.MemoryOutputStream.new_resizable();
            screenshot.screenshot_area(Math.floor(rect.x), Math.floor(rect.y), Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)), stream, (obj, res) => {
                try {
                    if (!obj)
                        throw new Error('screenshot object is null');
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
                        // Full resolution here, so keep the original subsampling.
                        step: Math.max(1, Math.floor(Math.min(width, height) / SAMPLE_MAX_EDGE)),
                    });
                }
                catch {
                    try {
                        stream.close(null);
                    }
                    catch { }
                    resolve(null);
                }
            });
        }
        catch {
            resolve(null);
        }
    });
}
export function backdropLuminance(actor, root = null) {
    let node = actor;
    for (let depth = 0; node && depth < BACKDROP_SEARCH_DEPTH; depth++) {
        try {
            const themeNode = node.get_theme_node?.();
            const color = themeNode?.get_background_color?.();
            if (color && color.alpha >= BACKDROP_COVERS_GLASS_ALPHA) {
                return {
                    luminance: _luminanceFromRgb(color.red, color.green, color.blue),
                    alpha: color.alpha,
                };
            }
        }
        catch {
            return null;
        }
        if (root && node === root)
            break;
        node = node.get_parent?.();
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
    try {
        const v = paintSignature();
        return Number.isFinite(v) ? v : null;
    }
    catch {
        return null;
    }
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
    // Un-premultiply before measuring luminance. Kept exactly as
    // the original pixbuf loop had it so the sampled value does not
    // shift; it only matters for semi-transparent pixels, which the
    // opaque desktop behind a menu rarely produces.
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
    // Created lazily on the first sample rather than in the constructor: the
    // managers all build a sampler up front, but most sessions never open the
    // menu/notification/OSD that would use it.
    _screenshot = null;
    _lastLuma = null;
    _lastIsBright = null;
    /** Monotonic time of the last polarity change (null: none yet); see SWITCH_SETTLE_MS. */
    _lastSwitchAt = null;
    /** The configuration the hold was started under; see decideTextColor(). */
    _holdConfig = '';
    _roundsSinceFlip = READABILITY_FLIP_COOLDOWN;
    _lastRawLuma = null;
    _lastRect = null;
    _lastDecided = null;
    // [PERF B4] "Nothing under the text has been redrawn since the last sample."
    // See chooseColorsForActors(). _unchangedSignature is the caller's paint
    // counter as of the end of the last capture (null = unknown, sample next
    // time); _unchangedKey is the rects and configuration that capture measured.
    _unchangedSignature = null;
    _unchangedKey = '';
    /** Forget the skip baseline, so the next call always samples. */
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
        try {
            const values = luminanceSamples(shot);
            if (values.length === 0) {
                _reportCapturePath('capture produced no usable pixels (everything below the alpha cutoff)');
                return null;
            }
            // [FIX] 0.10 -> 0.30. The rectangle handed to this function contains
            // the TEXT actors (the menu's root region, or the union of the text
            // rects), so a large minority of the pixels in it are the glyphs
            // themselves — and their colour is the very
            // thing this measurement decides. At a 10% trim the mean still moved by
            // roughly 0.1 in luminance when the text flipped, which on a background
            // sitting anywhere near the light/dark crossover is enough to flip the
            // decision straight back: the white -> black -> white -> black
            // ping-pong. Trimming 30% from each end keeps the middle 40% of the
            // sorted values — an interquartile mean — which is robust to that
            // contamination from BOTH ends (light text on a dark background and
            // dark text on a light one) and barely moves when the glyphs change
            // colour. The background itself, being the majority, still decides.
            return _trimmedMean(values, 0.30);
        }
        catch {
            return null;
        }
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
        // "Ambiguous" = the two candidates score within AMBIGUOUS_RATIO of each
        // other, i.e. the background is the half-way grey where neither colour is
        // meaningfully more readable. Computed from the RAW contrasts so the
        // classification reflects what is on screen right now.
        const ambiguous = Math.max(rawLight, rawDark) < Math.min(rawLight, rawDark) * AMBIGUOUS_RATIO;
        // Stateless path (one decision per element): there is no single "last
        // decision" that could hold, so the only stabiliser available is the
        // preference. In the ambiguous band it decides outright; outside it the
        // measurement still wins, exactly as before.
        if (config.samplePerElement) {
            if (ambiguous && hasPreference)
                return preferDark ? config.darkTextColor : config.lightTextColor;
            return rawDark > rawLight ? config.darkTextColor : config.lightTextColor;
        }
        // [FIX] Hold everything still for a moment after a flip. This function is
        // driven by a screenshot of the area the text is drawn on, so for the
        // ~380ms the colour tween runs, every measurement is partly a measurement
        // of our own in-progress change — a feedback loop that can sustain the
        // ping-pong on its own even with the hysteresis below. An unreadable
        // colour is never held when the other one is readable, and a changed
        // configuration (the preferred colour, the two text colours) ends the
        // hold: it is not a measurement, and the user expects it to apply at once.
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
            // [FIX] The oscillation zone, resolved by fiat. Inside this band the
            // preference is simply asserted; since the band is defined by the
            // measurement alone (no history), the result cannot depend on which
            // colour happens to be on screen, so it cannot oscillate.
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
            // Does flipping move us TOWARDS the preferred colour or away from it?
            const towardPreferred = hasPreference && preferDark !== isBright;
            const advantage = !hasPreference ? SWITCH_ADVANTAGE
                : (towardPreferred ? SWITCH_ADVANTAGE_TOWARD_PREFERRED : SWITCH_ADVANTAGE_AGAINST_PREFERRED);
            // A meaningful advantage prevents small sampling fluctuations changing polarity.
            if (alternative > current * advantage)
                isBright = !isBright;
        }
        // Smoothing must never delay an obvious readability correction after a
        // window/background changes. Use the current measurement for this decision.
        // This overrides the preference as well: a preference is about taste in the
        // cases where both colours work, never about keeping unreadable text.
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
     * @param paintSignature [PERF B4] Optional. Returns a counter that advances
     *   whenever the glass under the text is painted (LiquidEffect's paint
     *   count). The stage only repaints what is damaged, and anything that
     *   changes under the text — the backdrop, a hover highlight, the text
     *   itself — lies on top of that glass and therefore repaints it. So an
     *   unchanged counter means the pixels this would sample are the pixels it
     *   sampled last time, and the capture (a partial stage render, a GPU
     *   read-back and a PNG round trip) is skipped, returning an empty map:
     *   the colours already applied stay as they are. The sampling INTERVAL is
     *   untouched (memo.md 地雷10); only the cost of a sample that cannot
     *   change anything goes away.
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
        // `stable` is required on top of the counter check: the merged path's
        // decision is NOT a pure function of the pixels — it smooths the luma over
        // successive samples and holds for SWITCH_SETTLE_MS after a flip — so
        // re-measuring an unchanged screen can still move it until it converges.
        // Only a converged, repeated decision may be frozen.
        //
        // The capture paints the stage region itself, so it advances the counter
        // by (at most) one per screenshot. Anything beyond that means the screen
        // really changed while it was being taken; then no baseline is kept and
        // the next tick samples again.
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
        // Per-element decisions are stateless (see decideTextColor()), so the
        // same pixels always give the same answer.
        settle(true);
        return result;
    }
}
