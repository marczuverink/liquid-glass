import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';
import { GlassCard } from './desktopItem.js';
import { verticalBoxParams } from '../shellVersion.js';
const CARD_WIDTH = 300;
const ART_SIZE = 56;
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/**
 * The song or video that is playing (or was last), with buttons for the
 * previous track, play/pause and the next track. Talks to the players over
 * MPRIS directly; the card hides itself while no player is running.
 */
export class MediaWidget extends GlassCard {
    _art;
    _title;
    _artist;
    _playButton;
    _players = new Map();
    _ownerChangedId = 0;
    _cancellable = new Gio.Cancellable();
    _current = null;

    constructor(env) {
        super('media', env, CARD_WIDTH);
        this.shown = false;
        const row = new St.BoxLayout({ style_class: 'lg-row' });
        this._art = new St.Icon({ icon_size: ART_SIZE, style_class: 'lg-art', fallback_icon_name: 'audio-x-generic-symbolic' });
        const text = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, x_expand: true, ...verticalBoxParams() });
        this._title = new St.Label({ style_class: 'lg-title' });
        this._artist = new St.Label({ style_class: 'lg-dim' });
        for (const label of [this._title, this._artist])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        text.add_child(this._title);
        text.add_child(this._artist);
        row.add_child(this._art);
        row.add_child(text);
        const controls = new St.BoxLayout({ style_class: 'lg-controls', x_align: Clutter.ActorAlign.CENTER });
        const button = (icon, method) => {
            const b = new St.Button({ style_class: 'lg-control', can_focus: true,
                child: new St.Icon({ icon_name: icon, icon_size: 20 }) });
            b.connect('clicked', () => this._call(method));
            controls.add_child(b);
            return b;
        };
        button('media-skip-backward-symbolic', 'Previous');
        this._playButton = button('media-playback-start-symbolic', 'PlayPause');
        button('media-skip-forward-symbolic', 'Next');
        this.box.add_child(row);
        this.box.add_child(controls);
        this._ownerChangedId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE, (_c, _s, _p, _i, _sig, params) => {
            const [name, , newOwner] = params.deepUnpack();
            if (!name.startsWith(MPRIS_PREFIX))
                return;
            if (newOwner)
                this._addPlayer(name);
            else
                this._removePlayer(name);
        });
        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
            // Throws a GError when the bus call fails or is cancelled.
            try {
                const [names] = conn.call_finish(res).deepUnpack();
                for (const name of names)
                    if (name.startsWith(MPRIS_PREFIX))
                        this._addPlayer(name);
            }
            catch (e) {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    env.logger.log(`[Liquid Glass] Could not list media players: ${e}`);
            }
        });
    }

    _addPlayer(name) {
        if (this._players.has(name))
            return;
        const player = { name, proxy: null, changedId: 0, playedAt: 0 };
        this._players.set(name, player);
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, name, MPRIS_PATH, PLAYER_IFACE, this._cancellable, (_o, res) => {
            // Throws a GError when the proxy cannot be made or the wait was cancelled.
            try {
                player.proxy = Gio.DBusProxy.new_for_bus_finish(res);
            }
            catch (e) {
                if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    this.env.logger.log(`[Liquid Glass] Could not reach media player ${name}: ${e}`);
                return;
            }
            if (this._players.get(name) !== player)
                return;
            player.changedId = player.proxy.connect('g-properties-changed', () => this._update());
            this._update();
        });
    }

    _removePlayer(name) {
        const player = this._players.get(name);
        if (!player)
            return;
        this._players.delete(name);
        if (player.proxy && player.changedId)
            player.proxy.disconnect(player.changedId);
        if (this._current === player)
            this._current = null;
        this._update();
    }

    _property(player, name) {
        return player.proxy?.get_cached_property(name)?.recursiveUnpack() ?? null;
    }

    // The player that is playing, or the one that played last.
    _pick() {
        let best = null;
        const now = GLib.get_monotonic_time();
        for (const player of this._players.values()) {
            if (!player.proxy)
                continue;
            if (this._property(player, 'PlaybackStatus') === 'Playing')
                player.playedAt = now;
            if (!best || player.playedAt > best.playedAt)
                best = player;
        }
        return best;
    }

    _update() {
        const player = this._pick();
        this._current = player;
        const metadata = player ? this._property(player, 'Metadata') ?? {} : {};
        const title = metadata['xesam:title'] ?? '';
        const artists = metadata['xesam:artist'];
        this.shown = !!player && !!title;
        if (!this.shown)
            return;
        this._title.text = title;
        this._artist.text = Array.isArray(artists) ? artists.join(', ') : (artists ?? '');
        const art = metadata['mpris:artUrl'] ?? '';
        this._art.gicon = art ? new Gio.FileIcon({ file: Gio.File.new_for_uri(art) }) : null;
        const playing = this._property(player, 'PlaybackStatus') === 'Playing';
        this._playButton.child.icon_name = playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this.contentChanged();
    }

    _call(method) {
        this._current?.proxy?.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._ownerChangedId)
            Gio.DBus.session.signal_unsubscribe(this._ownerChangedId);
        this._ownerChangedId = 0;
        for (const name of [...this._players.keys()])
            this._removePlayer(name);
        super.destroy();
    }
}
