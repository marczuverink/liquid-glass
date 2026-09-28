export function getWindowActors() {
    if (global.compositor && typeof global.compositor.get_window_actors === 'function') {
        return global.compositor.get_window_actors();
    }
    if (typeof global.get_window_actors === 'function') {
        return global.get_window_actors();
    }
    return [];
}
