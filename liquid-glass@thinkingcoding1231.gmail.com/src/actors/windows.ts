
export function getWindowActors(): any[] {
  if (global.compositor && typeof (global.compositor as any).get_window_actors === 'function') {
    return (global.compositor as any).get_window_actors();
  }
  if (typeof (global as any).get_window_actors === 'function') {
    return (global as any).get_window_actors();
  }
  return [];
}
