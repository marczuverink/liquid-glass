import GObject from 'gi://GObject';
const _gobjectToString: (this: any) => string =
  (GObject as any).Object.prototype.toString;

export function isActorValid(actor: any): boolean {
  if (!actor) return false;

  let desc: string;
  try {
    desc = _gobjectToString.call(actor);
  } catch {
    return false;
  }
  if (desc.indexOf('(DISPOSED)') >= 0 || desc.indexOf('(FINALIZED)') >= 0)
    return false;

  try {
    return typeof actor.visible === 'boolean';
  } catch {
    return false;
  }
}
