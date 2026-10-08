// A rectangle hung on springs, one per edge: the glass that travels between
// two shapes (a menu growing out of its button). The edge in front is a
// little stiffer than the one behind, so the glass stretches as it moves and
// settles back into shape, like the jelly of glass-lib.
const STEP_S = 0.002;
const MAX_FRAME_S = 0.05;
// liquid_glass_widgets' morph spring (stiffness 120, damping 16), a little
// stiffer because the edges add their own lag. Damped enough that a large
// menu does not bounce once it has arrived.
export const JELLY_TRAVEL = {
    omega: 16, zeta: 0.9, lead: 0.45, minStretch: 0.55, maxStretch: 1.9,
};

export function rectToEdges(r) {
    return [r[0], r[1], r[0] + r[2], r[1] + r[3]];
}

export function edgesToRect(e) {
    return [e[0], e[1], Math.max(e[2] - e[0], 1), Math.max(e[3] - e[1], 1)];
}

export class Jelly {
    _spec = JELLY_TRAVEL;
    _edge = [0, 0, 1, 1];
    _vel = [0, 0, 0, 0];
    _mark = [0, 0, 1, 1];
    _from = [0, 0, 1, 1];
    _heading = [0, 0];
    _lastCentre = [0, 0];
    _lastUs = 0;
    _progress = 0;
    active = false;

    /** Starts at `from` [x, y, w, h], at rest. */
    start(from, spec = JELLY_TRAVEL) {
        this._spec = spec;
        this._edge = rectToEdges(from);
        this._mark = rectToEdges(from);
        this._from = rectToEdges(from);
        this._vel = [0, 0, 0, 0];
        this._heading = [0, 0];
        this._lastCentre = [(from[0] * 2 + from[2]) / 2, (from[1] * 2 + from[3]) / 2];
        this._lastUs = 0;
        this._progress = 0;
        this.active = true;
    }

    /** Where the glass is heading, [x, y, w, h]; it may move every frame. */
    setMark(rect) {
        this._mark = rectToEdges(rect);
    }

    /** Advances to `nowUs`; false once the glass has come to rest on the mark. */
    step(nowUs) {
        if (!this.active)
            return false;
        if (this._lastUs === 0)
            this._lastUs = nowUs - 16667;
        const elapsed = Math.min((nowUs - this._lastUs) / 1e6, MAX_FRAME_S);
        this._lastUs = nowUs;
        if (!(elapsed > 0))
            return true;
        let moving = false;
        for (let a = 0; a < 2; a++) {
            const lo = a, hi = a + 2;
            // Which way the mark is heading: quick to take up and slow to let go,
            // so the front edge stays the stiff one while the glass stops.
            const centre = (this._mark[lo] + this._mark[hi]) / 2;
            const want = Math.tanh((centre - this._lastCentre[a]) / elapsed / 700);
            this._lastCentre[a] = centre;
            const tau = Math.abs(want) > Math.abs(this._heading[a]) ? 0.03 : 0.12;
            this._heading[a] += (want - this._heading[a]) * (1 - Math.exp(-elapsed / tau));
            const rest = this._mark[hi] - this._mark[lo];
            const from = this._from[hi] - this._from[lo];
            const { omega, zeta, lead, minStretch, maxStretch } = this._spec;
            const lower = Math.max(Math.min(rest, from) * minStretch, 1);
            const upper = Math.max(Math.max(rest, from) * maxStretch, 1);
            for (let t = 0; t < elapsed; t += STEP_S) {
                const dt = Math.min(STEP_S, elapsed - t);
                this._spring(lo, omega * (1 - lead * this._heading[a]), zeta, dt);
                this._spring(hi, omega * (1 + lead * this._heading[a]), zeta, dt);
                // One piece of glass, not two loose edges.
                const w = this._edge[hi] - this._edge[lo];
                const c = (this._edge[lo] + this._edge[hi]) / 2;
                const clamped = Math.min(Math.max(w, lower), upper);
                if (clamped !== w) {
                    this._edge[lo] = c - clamped / 2;
                    this._edge[hi] = c + clamped / 2;
                }
            }
            for (const e of [lo, hi]) {
                if (Math.abs(this._edge[e] - this._mark[e]) >= 0.05 || Math.abs(this._vel[e]) >= 2)
                    moving = true;
            }
        }
        if (!moving) {
            this._edge = [...this._mark];
            this._vel = [0, 0, 0, 0];
            this.active = false;
        }
        this._progress = Math.max(this._progress, this._measureProgress());
        return moving;
    }

    _spring(e, omega, zeta, dt) {
        const acc = omega * omega * (this._mark[e] - this._edge[e]) - 2 * zeta * omega * this._vel[e];
        this._vel[e] += acc * dt;
        this._edge[e] += this._vel[e] * dt;
    }

    // How far the glass has come from where it started, 0 to 1.
    _measureProgress() {
        let total = 0, left = 0;
        for (let e = 0; e < 4; e++) {
            total = Math.max(total, Math.abs(this._mark[e] - this._from[e]));
            left = Math.max(left, Math.abs(this._mark[e] - this._edge[e]));
        }
        if (total < 0.5)
            return 1;
        return Math.min(Math.max(1 - left / total, 0), 1);
    }

    /** The glass now, [x, y, w, h]. */
    get rect() {
        return edgesToRect(this._edge);
    }

    /** How far it has come, 0 to 1; it never goes back. */
    get progress() {
        return this._progress;
    }
}
