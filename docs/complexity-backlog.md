# Complexity backlog

SonarJS (`eslint-plugin-sonarjs` 4.2.1, `recommended`) no longer reports any function over the cognitive-complexity limit of 15. What is left is listed below.

## Rules for this work

- Do not change behaviour. Refactor one thing per commit, and build and run the tests after each one.
- Do not add comments to code.
- Keep `!(x > 0)`-style guards as they are. They are deliberate NaN/undefined guards, and Sonar's `no-inverted-boolean-check` suggestion (`x <= 0`) changes behaviour. All 35 remaining reports of that rule are this pattern.
- The statics in `GlassGeometry` are intentionally mutable (tuned through setters on `LiquidEffect`), so the 8 `public-static-readonly` reports stay.
- Where you can, extract pure helpers and add a test that compares the new helper with a copy of the old inline code (see `tests/menu-spring.test.cjs`). For code with no test harness, compare the output of the previous `dist/` (it is committed) with the new one on the same fake inputs.
- Changes only take effect after a full GNOME session restart. Copy `dist/` to `~/.local/share/gnome-shell/extensions/liquid-glass@thinkingcoding1231.gmail.com/` and restart once, after a whole batch of changes.

## Commands

```sh
cd liquid-glass@thinkingcoding1231.gmail.com && npm run build
cd .. && node --test tests/
```

SonarJS is not a project dependency. To run it without touching the repo, install `eslint@9 eslint-plugin-sonarjs typescript-eslint` in a scratch directory. Then point a flat config at `src/**/*.ts`, `extension.js` and `prefs.js`, and run ESLint from the extension directory with `--no-config-lookup -c <config>`.

## Open items

- **Per-frame allocations.** The geometry helpers in `uiManager.ts` and `quickSettingsManager.ts` (`_measureMenu`/`_measurePanel`, the origin and scale tuples, `ToggleRegionLayout`, the submenu `gap` object) allocate on every animation tick. Splitting `LiquidEffect.vfunc_paint_target` added a `PaintCapture` object, the `_blurReuse` result and several destructurings on every paint of every glass. The per-frame `DockBounds` objects in the dock geometry and the tuple arrays passed to `_syncCaptureOffset` in `applicationManager.ts` are the same problem. Measure GC pressure on a live session first; if it shows, reuse a scratch object on the instance.
- **Frame-sync loop copies.** `QuickSettingsManager` uses `_startFrameSync`/`_stopFrameSync`/`_buildClones`, but `uiManager.ts`, `notificationManager.ts`, `osdManager.ts` and `dockManager.ts` still carry their own BEFORE_REDRAW loop and exclusion scan. The copies have drifted (`child.name` vs `child.get_name?.()`, `?? 0` or not, freeze re-queue vs return). Move that code into one shared helper next to `animation/frameSync.ts`.
- **Bounds helpers copied three times.** `UIManager._applyGlassBounds`, `QuickSettingsManager._applyPanelBounds` and `_applyToggleBounds` repeat the same transition removal, resize and padded clip sequence; `_resolveMenuOrigin`/`_resolvePanelOrigin`, `_applyGlassScale` and `_syncCaptureLayers` are also duplicated between the two managers. The copies already differ (`liquidBox.remove_clip()`, the order of `refresh` and `syncGlassCaptureClip`), so check each difference on a live session before merging them into one helper.
- **Mixed coordinate spaces in the bounds cache.** In `QuickSettingsManager`, the toggle path stores local `minX/minY` in `_lastBgX/_lastBgY` and the panel path stores absolute `bgX/bgY` in the same fields. This existed before the split. Reset the cache when switching modes, or keep one cache per path.
- **Unused position spring.** `stepMenuSprings` still steps the position spring, which nothing reads (kept to preserve behaviour exactly). Dropping it, with `_springPos`/`_swiftSpringPos`, is safe once someone confirms on a live session that the open/close animation looks the same.

## Other reports left on purpose

- `bitwise-operators` in `LiquidEffect.vfunc_paint`: `flags & ACTOR_DIRTY` is a bit test, not a typo.
- `no-invariant-returns` in `ApplicationManager._forceGlassReallocation`: a one-shot `later` callback always returns `false`.
- `no-nested-template-literals` in `src/applicationManager.ts`: diagnostic string only.
