import { UnpickableActor } from './unpickable.js';

/**
 * The actors of the clone-capturing glass: bgActor (monitor-sized) holds
 * liquidBox, which carries the LiquidEffect and holds the clone container.
 * A BackdropGlass needs none of them.
 */
export function createCaptureActors() {
    const bgActor = new UnpickableActor();
    bgActor.set_name('liquid-glass-bg-actor');
    bgActor.set_size(1.0, 1.0);
    const liquidBox = new UnpickableActor();
    liquidBox.set_name('liquid-box');
    liquidBox.set_clip_to_allocation(true);
    bgActor.add_child(liquidBox);
    // A transparent 1x1 child that works around Blur My Shell turning the
    // glass black.
    const dummyBreaker = new UnpickableActor();
    dummyBreaker.set_name('optimization-breaker');
    dummyBreaker.set_size(1.0, 1.0);
    dummyBreaker.set_opacity(0);
    liquidBox.add_child(dummyBreaker);
    const cloneContainer = new UnpickableActor();
    cloneContainer.set_name('clone-container');
    liquidBox.add_child(cloneContainer);
    return { bgActor, liquidBox, cloneContainer };
}
