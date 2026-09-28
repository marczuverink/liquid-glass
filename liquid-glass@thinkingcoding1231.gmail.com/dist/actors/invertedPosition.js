import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
export const InvertedPositionConstraint = GObject.registerClass({
    GTypeName: 'InvertedPositionConstraint',
    Properties: {
        'source': GObject.ParamSpec.object('source', 'Source', 'Source Actor', GObject.ParamFlags.READWRITE, Clutter.Actor.$gtype),
        'offset-x': GObject.ParamSpec.double('offset-x', 'Offset X', 'X Offset', GObject.ParamFlags.READWRITE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0),
        'offset-y': GObject.ParamSpec.double('offset-y', 'Offset Y', 'Y Offset', GObject.ParamFlags.READWRITE, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0.0),
    },
}, class InvertedPositionConstraint extends Clutter.Constraint {
    _sourceXId = 0;
    _sourceYId = 0;
    _init(props) {
        super._init(props);
        this.connect('notify::source', this._onSourceChanged.bind(this));
        this.connect('notify::offset-x', () => this._queueRelayout());
        this.connect('notify::offset-y', () => this._queueRelayout());
        if (this.source) {
            this._onSourceChanged();
        }
    }
    _queueRelayout() {
        try {
            const actor = this.get_actor();
            if (actor)
                actor.queue_relayout();
        }
        catch (_) { }
    }
    setOffset(x, y) {
        const nx = Number.isFinite(x) ? x : 0;
        const ny = Number.isFinite(y) ? y : 0;
        if (this.offset_x === nx && this.offset_y === ny)
            return;
        this.offset_x = nx;
        this.offset_y = ny;
        this._queueRelayout();
    }
    _onSourceChanged() {
        this._disconnectSignals();
        if (this.source) {
            const queueRelayout = () => {
                const actor = this.get_actor();
                if (actor) {
                    actor.queue_relayout();
                }
            };
            this._sourceXId = this.source.connect('notify::x', queueRelayout);
            this._sourceYId = this.source.connect('notify::y', queueRelayout);
            queueRelayout();
        }
    }
    _disconnectSignals() {
        if (!this.source)
            return;
        if (this._sourceXId) {
            this.source.disconnect(this._sourceXId);
            this._sourceXId = 0;
        }
        if (this._sourceYId) {
            this.source.disconnect(this._sourceYId);
            this._sourceYId = 0;
        }
    }
    vfunc_update_allocation(actor, allocation) {
        if (!this.source)
            return;
        const [x, y] = this.source.get_position();
        const width = allocation.get_width();
        const height = allocation.get_height();
        const targetX = -x + (this.offset_x ?? 0.0);
        const targetY = -y + (this.offset_y ?? 0.0);
        allocation.x1 = targetX;
        allocation.y1 = targetY;
        allocation.x2 = targetX + width;
        allocation.y2 = targetY + height;
    }
});
