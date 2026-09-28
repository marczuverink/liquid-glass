import GObject from 'gi://GObject';
const _gobjectToString = GObject.Object.prototype.toString;
export function isActorValid(actor) {
    if (!actor)
        return false;
    let desc;
    try {
        desc = _gobjectToString.call(actor);
    }
    catch {
        return false;
    }
    if (desc.indexOf('(DISPOSED)') >= 0 || desc.indexOf('(FINALIZED)') >= 0)
        return false;
    try {
        return typeof actor.visible === 'boolean';
    }
    catch {
        return false;
    }
}
