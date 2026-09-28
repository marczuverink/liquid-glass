import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';
export const UnpickableClone = GObject.registerClass(class UnpickableClone extends Clutter.Clone {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
    }
});
export const UnpickableActor = GObject.registerClass(class UnpickableActor extends Clutter.Actor {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
    }
});
export const UnpickableStyledWidget = GObject.registerClass(class UnpickableStyledWidget extends St.Widget {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
    }
});
export const LayoutOpaqueActor = GObject.registerClass(class LayoutOpaqueActor extends UnpickableActor {
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }
    vfunc_get_preferred_height(_forWidth) {
        return [0, 0];
    }
});
export const UnpickableWidget = GObject.registerClass(class UnpickableWidget extends St.Widget {
    _init(params = {}) {
        super._init(params);
        Shell.util_set_hidden_from_pick(this, true);
    }
    vfunc_pick(_pickContext) {
    }
});
