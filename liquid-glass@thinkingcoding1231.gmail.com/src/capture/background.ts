import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { utilsLog } from '../diagnostics/logging.js';
import Meta from 'gi://Meta';
import { isActorValid } from '../actors/lifecycle.js';
import Shell from 'gi://Shell';
import { UnpickableClone } from '../actors/unpickable.js';
/**
 * The wallpaper for the glass, without cloning the shell's _backgroundGroup.
 *
 * MetaBackgroundContent culls its painting against the current frame's
 * damage region, stored on the content object itself, and applies it inside a
 * clone's paint too. A clone of _backgroundGroup therefore painted the
 * wallpaper only where the frame was damaged, and a glass that re-captured on
 * such a frame latched black everywhere else.
 *
 * This actor holds its own Meta.BackgroundActor for each of the shell's,
 * sharing the same Meta.Background. They live outside the window group, so
 * mutter never sets a clip region on their content. Glasses still paint them
 * through a Clutter.Clone: when painted directly, an untransformed background
 * clips itself to the paint context's redraw clip instead, which is still the
 * frame's damage inside an offscreen buffer. Only the clone path paints the
 * whole rect. Cloning a group of mirrors also keeps the shell's wallpaper
 * cross-fade.
 */
export const BackgroundMirror = GObject.registerClass(
  class BackgroundMirror extends Clutter.Actor {
    declare _mirrors: Map<any, any>;
    declare _groupHandlers: number[];
    declare _sourceGroup: any;

    _init(params: any = {}): void {
      super._init(params);
      this._mirrors = new Map();
      this._groupHandlers = [];
      this._sourceGroup = null;

      const group = Main.layoutManager._backgroundGroup;
      this._sourceGroup = group;

      this._groupHandlers.push(
        group.connect('child-added', (_g: any, child: any) => this._addMirror(child)),
        group.connect('child-removed', (_g: any, child: any) => this._removeMirror(child)),
        // The shell moves a new wallpaper below the old one with
        // set_child_below_sibling(), which emits no child-added/removed, only
        // first-child/last-child. Without this the incoming wallpaper stayed
        // on top of the glass for the whole cross-fade.
        group.connect('notify::first-child', () => this._restack()),
        group.connect('notify::last-child', () => this._restack())
      );
      this.connect('destroy', () => this._onDestroy());

      for (const child of group.get_children()) this._addMirror(child);
    }

    // `background` carries the wallpaper; the rest are what the shell animates
    // for dimming and vignettes.
    _contentProps(): string[] {
      return [
        'background',
        'brightness',
        'vignette',
        'vignette-sharpness',
        'gradient',
        'gradient-height',
        'gradient-max-darkness',
        'rounded-clip-radius',
      ];
    }

    _addMirror(child: any): void {
      if (this._mirrors.has(child)) return;
      const srcContent = child.content;
      // Only mirror real wallpapers, not actors other extensions put there.
      if (!(srcContent instanceof Meta.BackgroundContent)) return;

      const mirror: any = new Meta.BackgroundActor({
        meta_display: global.display,
        monitor: child.monitor,
        reactive: false,
      });
      mirror.set_name('lg-bg-mirror');

      // Hidden until the content has a MetaBackground: painting a
      // MetaBackgroundContent without one crashes mutter
      // (meta_background_get_texture() dereferences it before its guard), and
      // the shell assigns the background after adding the actor.
      mirror.visible = false;

      const dstContent = mirror.content;
      this._bindMirrorContent(srcContent, dstContent);

      child.bind_property('opacity', mirror, 'opacity', GObject.BindingFlags.SYNC_CREATE);

      // Visibility also depends on the background being set, so it is
      // computed rather than bound.
      const syncVisible = () => {
        if (!isActorValid(mirror)) return;
        const wanted = !!mirror.content.background && isActorValid(child) && child.visible;
        if (mirror.visible !== wanted) mirror.visible = wanted;
      };
      const watchers: Array<[any, number]> = [
        [child, child.connect('notify::visible', syncVisible)],
        // first-child/last-child miss a reorder among middle children, and the
        // group holds two actors per monitor mid-fade. The fade changes
        // opacity every frame, and _restack() only writes on a change.
        [child, child.connect('notify::opacity', () => this._restack())],
        [dstContent, dstContent.connect('notify::background', syncVisible)],
      ];
      mirror.connect('destroy', () => {
        for (const [obj, id] of watchers)
          obj.disconnect(id);
        watchers.length = 0;
      });
      syncVisible();

      // The background group and this actor share an origin, so binding the
      // geometry follows monitor changes too.
      mirror.set_position(child.x, child.y);
      mirror.set_size(child.width, child.height);
      for (const coordinate of [
        Clutter.BindCoordinate.X,
        Clutter.BindCoordinate.Y,
        Clutter.BindCoordinate.WIDTH,
        Clutter.BindCoordinate.HEIGHT,
      ]) {
        mirror.add_constraint(new Clutter.BindConstraint({ source: child, coordinate }));
      }

      this._mirrors.set(child, mirror);
      this.add_child(mirror);
      // The cross-fade depends on matching the group's stacking.
      this._restack();
    }

    _bindMirrorContent(srcContent: any, dstContent: any): void {
      for (const prop of this._contentProps())
        srcContent.bind_property(prop, dstContent, prop, GObject.BindingFlags.SYNC_CREATE);
    }

    _removeMirror(child: any): void {
      const mirror = this._mirrors.get(child);
      if (!mirror) return;
      this._mirrors.delete(child);
      if (isActorValid(mirror)) mirror.destroy();
    }

    // Matches the background group's order. set_child_at_index() queues a
    // relayout even for an unchanged index, so compare first.
    _restack(): void {
      if (!isActorValid(this._sourceGroup)) return;

      const wanted: any[] = [];
      for (const child of this._sourceGroup.get_children()) {
        const mirror = this._mirrors.get(child);
        if (mirror && isActorValid(mirror)) wanted.push(mirror);
      }

      const current = this.get_children();
      let ordered = current.length === wanted.length;
      if (ordered) {
        for (let i = 0; i < wanted.length; i++) {
          if (current[i] !== wanted[i]) { ordered = false; break; }
        }
      }
      if (ordered) return;

      for (let i = 0; i < wanted.length; i++) this.set_child_at_index(wanted[i], i);
      utilsLog(`[bg-mirror] restacked ${wanted.length} wallpaper mirror(s)`);
    }

    _onDestroy(): void {
      if (isActorValid(this._sourceGroup)) {
        for (const id of this._groupHandlers)
          this._sourceGroup.disconnect(id);
      }
      this._groupHandlers = [];
      this._mirrors.clear();
      this._sourceGroup = null;
    }

    vfunc_pick(_pickContext: any): void {
    }
  }
);

// false clones _backgroundGroup directly, for comparison (global._lgGlass.bgMirror).
let _backgroundMirrorEnabled = true;
export function setBackgroundMirrorEnabled(enabled: boolean): void {
  _backgroundMirrorEnabled = !!enabled;
}
export function isBackgroundMirrorEnabled(): boolean {
  return _backgroundMirrorEnabled;
}

// One BackgroundMirror shared by every glass, since rebuilding clones would
// otherwise keep creating new background contents.
let _sharedBackgroundSource: any = null;

function ensureSharedBackgroundSource(): any {
  if (isActorValid(_sharedBackgroundSource)) return _sharedBackgroundSource;
  _sharedBackgroundSource = null;

  const uiGroup = Main.layoutManager.uiGroup;
  const group = Main.layoutManager._backgroundGroup;

  const source: any = new BackgroundMirror();
  source.set_name('lg-bg-mirror-source');
  source.set_position(0, 0);
  source.set_size(group.width, group.height);
  // A clone scales its source to its own size, so the source has to follow
  // the group's size through monitor changes.
  for (const coordinate of [Clutter.BindCoordinate.WIDTH, Clutter.BindCoordinate.HEIGHT])
    source.add_constraint(new Clutter.BindConstraint({ source: group, coordinate }));

  // Opacity 0 rather than hidden: clutter_actor_paint() skips it on screen,
  // but a clone paints its source with the clone's own opacity, and the
  // source stays mapped and allocated.
  source.opacity = 0;
  source.reactive = false;
  Shell.util_set_hidden_from_pick(source, true);

  // Outside global.window_group, where mutter's culling cannot reach it.
  uiGroup.add_child(source);
  source.connect('destroy', () => {
    if (_sharedBackgroundSource === source) _sharedBackgroundSource = null;
  });

  _sharedBackgroundSource = source;
  return source;
}

/** The shared source if one exists; never creates one. */
export function getSharedBackgroundSource(): any {
  return isActorValid(_sharedBackgroundSource) ? _sharedBackgroundSource : null;
}

/** Tears the shared source down; call from the extension's disable(). */
export function destroySharedBackgroundSource(): void {
  const source = _sharedBackgroundSource;
  _sharedBackgroundSource = null;
  if (isActorValid(source))
    source.destroy();
}

/**
 * The wallpaper actor at the back of a glass: always a clone (see
 * BackgroundMirror), of the shared mirror unless switched off.
 */
export function createBackgroundMirror(name: string): Clutter.Actor {
  const source = _backgroundMirrorEnabled
    ? ensureSharedBackgroundSource()
    : Main.layoutManager._backgroundGroup;

  const clone: any = new UnpickableClone({ source });
  clone.set_name(name);
  return clone;
}
