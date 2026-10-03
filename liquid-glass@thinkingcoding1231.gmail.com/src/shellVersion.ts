import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// The few shell calls whose signature differs between the supported versions.
export const SHELL_MAJOR = parseInt(Config.PACKAGE_VERSION, 10);

// PopupMenu.open() and close() take {animate} from GNOME 51 on, and a
// BoxPointer.PopupAnimation (0 for none) before.
export const MENU_NO_ANIMATION: any = SHELL_MAJOR >= 51 ? { animate: false } : 0;
