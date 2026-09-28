
let _captureClipEnabled = false;
let _cloneCullEnabled = true;

export function setCaptureClipEnabled(enabled: boolean): void {
  _captureClipEnabled = !!enabled;
}

export function isCaptureClipEnabled(): boolean {
  return _captureClipEnabled;
}

export function setCloneCullEnabled(enabled: boolean): void {
  _cloneCullEnabled = !!enabled;
}

export function isCloneCullEnabled(): boolean {
  return _cloneCullEnabled;
}

let _cullApp = true;
let _cullWindows = true;
let _cullUi = true;
let _cullBms = true;

export type CullSite = 'app' | 'windows' | 'ui' | 'bms';

export function setCullSiteEnabled(site: CullSite, enabled: boolean): void {
  if (site === 'app') _cullApp = !!enabled;
  else if (site === 'windows') _cullWindows = !!enabled;
  else if (site === 'bms') _cullBms = !!enabled;
  else _cullUi = !!enabled;
}

export function isCullSiteEnabled(site: CullSite): boolean {
  if (!_cloneCullEnabled) return false;
  if (site === 'app') return _cullApp;
  if (site === 'windows') return _cullWindows;
  if (site === 'bms') return _cullBms && _cullUi;
  return _cullUi;
}

export type GlassRect = [number, number, number, number];
