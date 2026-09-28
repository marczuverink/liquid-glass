// [PERF C1] The longest frame the physics follows in full: covers the 20fps
// cap the preferences offer, so a capped animation runs at the same speed.
// Longer gaps (a stall) are clamped rather than jumped over.
export const MAX_STEP_S = 0.066;
const SUB_STEP_S = 0.002;
// A straightforward mathematical implementation of Hooke's Law for spring physics
export class Spring {
    stiffness;
    damping;
    mass;
    value;
    velocity;
    target;
    constructor(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping; // Friction (higher = less bounce, settles quicker)
        this.mass = mass; // Weight of the object
        this.value = 0; // Current position/scale
        this.velocity = 0; // Current speed
        this.target = 0; // Destination value
    }
    updateParams(stiffness, damping, mass) {
        this.stiffness = stiffness; // How rigid the spring is (higher = faster, more snappy)
        this.damping = damping; // Friction (higher = less bounce, settles quicker)
        this.mass = mass; // Weight of the object
    }
    update(elapsedMs) {
        // Cap max delta time to prevent the spring from violently exploding during heavy CPU load
        let dt = elapsedMs / 1000;
        if (dt > MAX_STEP_S)
            dt = MAX_STEP_S;
        // [PERF C1] Sub-stepped. The integrator is explicit (semi-implicit Euler),
        // and with the stiffness the preferences allow a 16.7ms frame is not a
        // stable step. The old 1ms GLib timer hid that by stepping — and repainting
        // — a thousand times a second. Now the physics keeps its fine step while
        // the frame driver writes the actors once per frame.
        const mass = this.mass > 1e-3 ? this.mass : 1e-3;
        let remaining = dt;
        while (remaining > 1e-6) {
            const h = Math.min(remaining, SUB_STEP_S);
            // F = -k * x
            const springForce = -this.stiffness * (this.value - this.target);
            // F = -c * v
            const dampingForce = -this.damping * this.velocity;
            // a = F / m
            const acceleration = (springForce + dampingForce) / mass;
            // Semi-implicit Euler
            this.velocity += acceleration * h;
            this.value += this.velocity * h;
            remaining -= h;
        }
        // Return true if the spring has virtually stopped moving and reached its destination
        return Math.abs(this.velocity) < 0.01 && Math.abs(this.value - this.target) < 0.001;
    }
}
export class SwiftSpring {
    response;
    dampingFraction;
    mass;
    value;
    velocity;
    target;
    constructor(response, dampingFraction, mass = 1.0) {
        this.response = typeof response === 'number' && !isNaN(response) && response > 0.01 ? response : 0.4;
        this.dampingFraction = typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0 ? dampingFraction : 0.7;
        this.mass = typeof mass === 'number' && !isNaN(mass) && mass > 0.01 ? mass : 1.0;
        this.value = 0;
        this.velocity = 0;
        this.target = 0;
    }
    updateParams(response, dampingFraction, mass = 1.0) {
        if (typeof response === 'number' && !isNaN(response) && response > 0.01)
            this.response = response;
        if (typeof dampingFraction === 'number' && !isNaN(dampingFraction) && dampingFraction >= 0)
            this.dampingFraction = dampingFraction;
        if (typeof mass === 'number' && !isNaN(mass) && mass > 0.01)
            this.mass = mass;
    }
    update(elapsedMs) {
        let dt = elapsedMs / 1000;
        if (isNaN(dt) || dt <= 0)
            return false;
        if (dt > 0.1)
            dt = 0.1;
        if (isNaN(this.value) || !isFinite(this.value) || isNaN(this.velocity) || !isFinite(this.velocity)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const x0 = this.value - this.target;
        const v0 = this.velocity;
        if (Math.abs(x0) < 0.001 && Math.abs(v0) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        const omega0 = (2 * Math.PI) / this.response;
        const zeta = this.dampingFraction;
        let x_t = 0;
        let v_t = 0;
        // Analytical solution — no numerical explosion regardless of spring stiffness
        if (zeta < 0.999) {
            // 1. Underdamped — standard bouncy motion
            const omegaD = omega0 * Math.sqrt(1.0 - zeta * zeta);
            const alpha = zeta * omega0;
            const exp = Math.exp(-alpha * dt);
            const cos = Math.cos(omegaD * dt);
            const sin = Math.sin(omegaD * dt);
            x_t = exp * (x0 * cos + ((v0 + alpha * x0) / omegaD) * sin);
            v_t = exp * (v0 * cos - ((alpha * v0 + omega0 * omega0 * x0) / omegaD) * sin);
        }
        else if (zeta > 1.001) {
            // 2. Overdamped — slow, viscous motion
            const beta = omega0 * Math.sqrt(zeta * zeta - 1.0);
            const gamma1 = -zeta * omega0 + beta;
            const gamma2 = -zeta * omega0 - beta;
            const exp1 = Math.exp(gamma1 * dt);
            const exp2 = Math.exp(gamma2 * dt);
            const c1 = (v0 - gamma2 * x0) / (gamma1 - gamma2);
            const c2 = x0 - c1;
            x_t = c1 * exp1 + c2 * exp2;
            v_t = c1 * gamma1 * exp1 + c2 * gamma2 * exp2;
        }
        else {
            // 3. Critically damped — fastest settle without overshoot
            const exp = Math.exp(-omega0 * dt);
            x_t = exp * (x0 + (v0 + omega0 * x0) * dt);
            v_t = exp * (v0 - omega0 * (v0 + omega0 * x0) * dt);
        }
        this.value = x_t + this.target;
        this.velocity = v_t;
        if (isNaN(this.value) || !isFinite(this.value)) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        this.value = Math.max(-0.5, Math.min(2.5, this.value));
        if (Math.abs(this.value - this.target) < 0.001 && Math.abs(this.velocity) < 0.001) {
            this.value = this.target;
            this.velocity = 0;
            return true;
        }
        return false;
    }
}
