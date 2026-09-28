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
let _cullApp = true;
let _cullWindows = true;
let _cullUi = true;
export function setCullSiteEnabled(site, enabled) {
    if (site === 'app')
        _cullApp = !!enabled;
    else if (site === 'windows')
        _cullWindows = !!enabled;
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
    return _cullUi;
}
