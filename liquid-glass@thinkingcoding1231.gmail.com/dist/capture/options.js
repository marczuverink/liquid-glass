// Two ways to cut the cost of painting a glass's clone subtree into its
// offscreen buffer. For the dock, menus, notifications, OSD and Quick Settings
// that subtree covers the whole monitor, because their background actor is
// monitor-sized (Blur My Shell's panel blur samples in stage coordinates).
//
// captureClip: set_clip() on the clone container. The clip applies inside the
//   offscreen buffer, whose size and origin do not change. Measured slower
//   than not clipping (the buffer is still cleared in full and the clip breaks
//   batching), so it is off by default.
// cloneCull: zero the opacity of clones outside the glass rect. A culled clone
//   does not paint its source, so glass nested inside it does not render at
//   all. This is where the saving is.
//
// Both can be toggled from global._lgGlass for comparison.
let _captureClipEnabled = false;
let _cloneCullEnabled = true;

export function setCaptureClipEnabled(enabled) {
    _captureClipEnabled = !!enabled;
}

export function isCaptureClipEnabled() {
    return _captureClipEnabled;
}

export function setCloneCullEnabled(enabled) {
    _cloneCullEnabled = !!enabled;
}

export function isCloneCullEnabled() {
    return _cloneCullEnabled;
}

// The cull runs at separate sites, each ANDed with cloneCull:
//   app      behind-window clones inside a window's own glass
//   windows  window clones inside the dock, menus, notifications, OSD, Quick Settings
//   ui       uiGroup clones in those same surfaces
//   bms      Blur My Shell panel replicas out of the glass's reach; when off,
//            they are never culled and their band always joins the cull rect
let _cullApp = true;
let _cullWindows = true;
let _cullUi = true;
let _cullBms = true;

export function setCullSiteEnabled(site, enabled) {
    if (site === 'app')
        _cullApp = !!enabled;
    else if (site === 'windows')
        _cullWindows = !!enabled;
    else if (site === 'bms')
        _cullBms = !!enabled;
    else
        _cullUi = !!enabled;
}

export function isCullSiteEnabled(site) {
    if (!_cloneCullEnabled)
        return false;
    if (site === 'app')
        return _cullApp;
    if (site === 'windows')
        return _cullWindows;
    if (site === 'bms')
        return _cullBms && _cullUi;
    return _cullUi;
}
