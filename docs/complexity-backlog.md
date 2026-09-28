# Complexity backlog

SonarJS (`eslint-plugin-sonarjs` 4.2.1, `recommended`) flags these functions for cognitive complexity above 15. The easy, testable ones are already split (menu spring, contrast sampling, toggle styles, panel menu scan, diagnostics dump, quick-settings frame sync). What is left runs every frame, drives the render pipeline, or tears down live actors, so each change needs care and a live check.

## Rules for this work

- Do not change behaviour. Refactor one function per commit, and build and run the tests after each one.
- Do not add comments to code.
- Keep `!(x > 0)`-style guards as they are. They are deliberate NaN/undefined guards, and Sonar's `no-inverted-boolean-check` suggestion (`x <= 0`) changes behaviour. The 30 remaining reports of that rule are all this pattern, so leave them.
- The statics in `GlassGeometry` are intentionally mutable (tuned through setters on `LiquidEffect`), so leave the 8 `public-static-readonly` reports alone.
- Where you can, extract pure helpers and add a test that compares the new helper with a copy of the old inline code (see `tests/menu-spring.test.cjs`). For code with no test harness, compare the output of the previous `dist/` (it is committed) with the new one on the same fake inputs.
- Changes only take effect after a full GNOME session restart. Copy `dist/` to `~/.local/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/` and restart once, after a whole batch of changes.

## Commands

```sh
cd liquid-glass@thinkingcoding1231.gmail.com && npm run build
cd .. && node --test tests/
```

SonarJS is not a project dependency. To run it without touching the repo, install `eslint@9 eslint-plugin-sonarjs typescript-eslint` in a scratch directory. Then point a flat config at `src/**/*.ts`, `extension.js` and `prefs.js`, and run ESLint from the extension directory with `--no-config-lookup -c <config>`.

## Remaining functions

Complexity is Sonar's score (limit 15). Line numbers are from commit `571bba9`.

### Hardest: every-frame geometry and the render pipeline

| Score | Function | Notes |
|---:|---|---|
| 146 | `DashManager._syncGeometry` (`src/dockManager.ts:381`) | Dock position, gap and margin handling for every dock orientation, run every frame. Split the geometry maths (pure) from the actor writes first. |
| 80 | `LiquidEffect.vfunc_paint_target` (`src/liquidEffect.ts:174`) | Capture → crop → blur → composite. Paint-time code: nothing may queue a relayout or repaint from inside it. The existing tests in `tests/renderer-lifecycle.test.cjs` cover blur reuse and fallbacks. |
| 77 | `UILayerSampler.refresh` (`src/capture/uiLayerSampler.ts:479`) | Builds and removes uiGroup clones and BMS replicas. |
| 63 | `QuickSettingsManager._updateSingleButtonAlpha` (`src/quickSettingsManager.ts:1354`) | Button background alpha from sampled colours. |
| 38 | `QuickSettingsManager._syncGeometry` (`src/quickSettingsManager.ts:936`) | |
| 34 | `UILayerSampler._syncBmsReplica` (`src/capture/uiLayerSampler.ts:248`) | Blur My Shell compatibility. |
| 34 | `WindowCloneManager.sync` (`src/capture/windowClones.ts:135`) | Per-frame window clone placement and culling. |
| 31 | `ApplicationManager._syncClones` (`src/applicationManager.ts:1151`) | |
| 28 | `QuickSettingsManager._syncToggleRegions` (`src/quickSettingsManager.ts:798`) | |
| 27 | `UIManager._syncGeometry` (`src/uiManager.ts:838`) | |
| 22 | `OsdManager._syncGeometry` (`src/osdManager.ts:433`) | |
| 20 | `syncGlassCaptureClip` (`src/capture/clip.ts:8`) | |
| 20 | `UILayerSampler.sync` (`src/capture/uiLayerSampler.ts:729`) | |
| 17 | `ApplicationManager._frameTick` (`src/applicationManager.ts:1270`) | |
| 17 | `TextureBlitActor.vfunc_paint` (`src/actors/textureBlit.ts:40`) | Paint-time code. |
| 16 | `UILayerSampler.syncProperties` (`src/capture/uiLayerSampler.ts:620`) | |

### Setup and teardown of live actors

| Score | Function | Notes |
|---:|---|---|
| 26 | `QuickSettingsManager._removeEffect` (`src/quickSettingsManager.ts:1640`) | Every step must survive a disposed actor. Consider the `_teardownStep(name, fn)` pattern from `panelMenuManager.ts`. |
| 25 | `UIManager._removeEffect` (`src/uiManager.ts:1290`) | Same. |
| 25 | `ApplicationManager._cleanupState` (`src/applicationManager.ts:1485`) | Same. |
| 23 | `ApplicationManager._syncStateInner` (`src/applicationManager.ts:929`) | |
| 21 | `OsdManager._applyEffect` (`src/osdManager.ts:233`) | |
| 20 | `ApplicationManager._syncDamageHooks` (`src/applicationManager.ts:1117`) | |
| 20 | `WindowCloneManager._syncDamageHooks` (`src/capture/windowClones.ts:99`) | Near-duplicate of the one above; a shared helper may remove both. |
| 19 | `ApplicationManager._repairNestedGlass` (`src/applicationManager.ts:1083`) | |
| 19 | `QuickSettingsManager._clearButtonStyles` (`src/quickSettingsManager.ts:1475`) | |
| 18 | `BackgroundMirror._addMirrorUnsafe` (`src/capture/background.ts:57`) | |
| 18 | `SelfExcludingSnapshotCapture._captureOnce` (`src/capture/snapshot.ts:70`) | |
| 17 | `OsdManager._setupOsdEffect` (`src/osdManager.ts:302`) | |
| 17 | `OsdManager._cleanupOsdState` (`src/osdManager.ts:573`) | |

### Smaller, lower risk

| Score | Function | Notes |
|---:|---|---|
| 26 | `WindowListService._collectWindows` (`src/windowListService.ts:141`) | No tests yet; add some first. |
| 23 | `_reconcileCullOptOut` (`src/capture/windowCulling.ts:14`) | |
| 18 | `findBoundaries` closure (`src/quickSettingsManager.ts:1585`) | |
| 17 | `QuickSettingsManager._adjustSubmenuPositions` (`src/quickSettingsManager.ts:1533`) | |
| 16 | `AdaptiveColorTweener._tick` (`src/animation/colors.ts:127`) | |

## Duplication to remove

- The BEFORE_REDRAW frame-sync loop (laterAdd, frameTick with its torn-down and freeze checks, buildClones with the `liquid-glass-bg-actor`/`liquid-box` exclusion scan) is copied in `uiManager.ts`, `notificationManager.ts`, `osdManager.ts` and `dockManager.ts`. `QuickSettingsManager` already uses `_startFrameSync`/`_stopFrameSync`/`_buildClones`. The copies have drifted (`child.name` vs `child.get_name?.()`, `?? 0` or not, freeze re-queue vs return), so move that code into one shared helper next to `animation/frameSync.ts` and use it everywhere.
- `stepMenuSprings` still steps the position spring, which nothing reads (kept to preserve behaviour exactly). Dropping it, with `_springPos`/`_swiftSpringPos`, is safe once someone confirms on a live session that the open/close animation looks the same.

## Other reports left on purpose

- `bitwise-operators` in `LiquidEffect.vfunc_paint`: `flags & ACTOR_DIRTY` is a bit test, not a typo.
- `no-invariant-returns` in `ApplicationManager._forceGlassReallocation`: a one-shot `later` callback always returns `false`.
- `no-nested-template-literals` in `src/applicationManager.ts`: diagnostic string only.
