import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { formatTime } from 'resource:///org/gnome/shell/misc/dateUtils.js';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GWeather from 'gi://GWeather';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import { GlassCard, type ItemEnv } from './desktopItem.js';
import { verticalBoxParams } from '../shellVersion.js';

const CARD_WIDTH = 300;
const HOURS = 5;
// Open-Meteo is asked again after this long.
const REFRESH_S = 30 * 60;
const USER_AGENT = 'Liquid Glass GNOME Shell extension (https://github.com/ryohsuke1231/liquid-glass)';

interface Hour { label: string; icon: string; temp: string; }

interface Report {
  place: string;
  temp: string;
  summary: string;
  icon: string;
  range: string;
  hours: Hour[];
  // The source's notice that has to be shown with its data.
  credit: string;
}

type Unit = 'auto' | 'celsius' | 'fahrenheit';

function sanitizeUnit(value: string): Unit {
  return value === 'celsius' || value === 'fahrenheit' ? value : 'auto';
}

function degrees(value: number): string {
  return `${Math.round(value)}°`;
}

// WMO weather codes, as Open-Meteo reports them.
const CODES: Record<number, [string, string, string?]> = {
  0: ['Clear', 'weather-clear-symbolic', 'weather-clear-night-symbolic'],
  1: ['Mostly Clear', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
  2: ['Partly Cloudy', 'weather-few-clouds-symbolic', 'weather-few-clouds-night-symbolic'],
  3: ['Cloudy', 'weather-overcast-symbolic'],
  45: ['Fog', 'weather-fog-symbolic'],
  48: ['Rime Fog', 'weather-fog-symbolic'],
  51: ['Light Drizzle', 'weather-showers-scattered-symbolic'],
  53: ['Drizzle', 'weather-showers-scattered-symbolic'],
  55: ['Heavy Drizzle', 'weather-showers-scattered-symbolic'],
  56: ['Freezing Drizzle', 'weather-showers-scattered-symbolic'],
  57: ['Freezing Drizzle', 'weather-showers-scattered-symbolic'],
  61: ['Light Rain', 'weather-showers-scattered-symbolic'],
  63: ['Rain', 'weather-showers-symbolic'],
  65: ['Heavy Rain', 'weather-showers-symbolic'],
  66: ['Freezing Rain', 'weather-showers-symbolic'],
  67: ['Freezing Rain', 'weather-showers-symbolic'],
  71: ['Light Snow', 'weather-snow-symbolic'],
  73: ['Snow', 'weather-snow-symbolic'],
  75: ['Heavy Snow', 'weather-snow-symbolic'],
  77: ['Snow Grains', 'weather-snow-symbolic'],
  80: ['Rain Showers', 'weather-showers-scattered-symbolic'],
  81: ['Rain Showers', 'weather-showers-symbolic'],
  82: ['Violent Showers', 'weather-showers-symbolic'],
  85: ['Snow Showers', 'weather-snow-symbolic'],
  86: ['Heavy Snow Showers', 'weather-snow-symbolic'],
  95: ['Thunderstorm', 'weather-storm-symbolic'],
  96: ['Thunderstorm, Hail', 'weather-storm-symbolic'],
  99: ['Thunderstorm, Hail', 'weather-storm-symbolic'],
};

function wmo(code: number, isDay: boolean): [string, string] {
  const [text, icon, night] = CODES[code] ?? ['Unknown', 'weather-severe-alert-symbolic'];
  return [text, !isDay && night ? night : icon];
}

/**
 * Today's weather and the next hours. It shows what GNOME Weather has set up
 * (the location the shell's calendar menu shows the weather for), through
 * the shell's own weather client; without GNOME Weather it asks Open-Meteo
 * for the location typed in the preferences.
 */
export class WeatherWidget extends GlassCard {
  private _place: St.Label;
  private _icon: St.Icon;
  private _temp: St.Label;
  private _summary: St.Label;
  private _hours: St.BoxLayout;
  private _credit: St.Label;
  private _client: any = null;
  private _clientId = 0;
  private _weatherSettingsIds: number[] = [];
  private _session: any = null;
  private _cancellable: Gio.Cancellable | null = null;
  private _timerId = 0;
  private _geocoded: { query: string, name: string, lat: number, lon: number } | null = null;

  constructor(env: ItemEnv) {
    super('weather', env, CARD_WIDTH);
    this._place = new St.Label({ style_class: 'lg-title' });
    const row = new St.BoxLayout({ style_class: 'lg-row' });
    this._icon = new St.Icon({ icon_size: 44, y_align: Clutter.ActorAlign.CENTER });
    this._temp = new St.Label({ style_class: 'lg-big', y_align: Clutter.ActorAlign.CENTER });
    this._summary = new St.Label({ style_class: 'lg-dim', y_align: Clutter.ActorAlign.CENTER, x_expand: true });
    row.add_child(this._icon);
    row.add_child(this._temp);
    row.add_child(this._summary);
    this._hours = new St.BoxLayout({ style_class: 'lg-hours', x_expand: true });
    this._credit = new St.Label({ style_class: 'lg-small', visible: false });
    for (const child of [this._place, row, this._hours, this._credit]) this.box.add_child(child);

    for (const key of ['weather-location', 'weather-temperature-unit'])
      this._weatherSettingsIds.push(env.settings.connect(`changed::${key}`, () => this._refresh()));
    this._refresh();
  }

  private _unit(): Unit {
    return sanitizeUnit(this.env.settings.get_string('weather-temperature-unit'));
  }

  // The shell's weather client, or null without GNOME Weather.
  private _shellClient(): any {
    const client = (Main.panel.statusArea as any).dateMenu?._weatherItem?._weatherClient ?? null;
    return client?.available ? client : null;
  }

  private _refresh(): void {
    const client = this._shellClient();
    if (client !== this._client) {
      if (this._client && this._clientId) this._client.disconnect(this._clientId);
      this._client = client;
      this._clientId = client ? client.connect('changed', () => this._showShellWeather()) : 0;
    }
    if (client) {
      this._stopOpenMeteo();
      client.update();
      this._showShellWeather();
      return;
    }
    this._startOpenMeteo();
  }

  protected activate(): void {
    this._client?.activateApp();
  }

  private _show(report: Report | string): void {
    if (typeof report === 'string') {
      this._place.text = 'Weather';
      this._icon.icon_name = 'weather-severe-alert-symbolic';
      this._temp.text = '';
      this._summary.text = report;
      this._summary.clutter_text.line_wrap = true;
      this._hours.destroy_all_children();
      this._credit.visible = false;
      this.contentChanged();
      return;
    }
    this._place.text = report.place;
    this._icon.icon_name = report.icon;
    this._temp.text = report.temp;
    this._summary.text = report.range ? `${report.summary}\n${report.range}` : report.summary;
    this._hours.destroy_all_children();
    for (const hour of report.hours) {
      const column = new St.BoxLayout({ style_class: 'lg-hour', x_expand: true, ...verticalBoxParams() } as any);
      column.add_child(new St.Label({ text: hour.label, style_class: 'lg-small', x_align: Clutter.ActorAlign.CENTER }));
      column.add_child(new St.Icon({ icon_name: hour.icon, icon_size: 18, x_align: Clutter.ActorAlign.CENTER }));
      column.add_child(new St.Label({ text: hour.temp, style_class: 'lg-small', x_align: Clutter.ActorAlign.CENTER }));
      this._hours.add_child(column);
    }
    this._credit.text = report.credit;
    this._credit.visible = !!report.credit;
    this.contentChanged();
  }

  private _shellTemp(info: any): string {
    const unit = this._unit();
    const wanted = unit === 'celsius' ? GWeather.TemperatureUnit.CENTIGRADE
      : unit === 'fahrenheit' ? GWeather.TemperatureUnit.FAHRENHEIT : GWeather.TemperatureUnit.DEFAULT;
    const [ok, value] = info.get_value_temp(wanted);
    return ok ? degrees(value) : '';
  }

  private _showShellWeather(): void {
    const client = this._client;
    if (!client) return;
    const info = client.info;
    if (!client.hasLocation) {
      this._show('Choose a location in GNOME Weather');
      return;
    }
    if (!info?.is_valid()) {
      this._show(client.loading ? 'Loading…' : 'Weather is not available right now');
      return;
    }
    const conditions = info.get_conditions();
    const summary = conditions && conditions !== '-' ? conditions : info.get_sky();
    const now = GLib.DateTime.new_now_local();
    let last = GLib.DateTime.new_from_unix_local(0);
    const hours: Hour[] = [];
    for (const forecast of info.get_forecast_list()) {
      const [valid, timestamp] = forecast.get_value_update();
      if (!valid || timestamp === 0) continue;
      const time = GLib.DateTime.new_from_unix_local(timestamp);
      // Only the hours to come, at least an hour apart.
      if (now.difference(time) > 0 || time.difference(last) < GLib.TIME_SPAN_HOUR) continue;
      last = time;
      hours.push({
        label: formatTime(new Date(timestamp * 1000), { timeOnly: true }),
        icon: forecast.get_symbolic_icon_name(),
        temp: this._shellTemp(forecast),
      });
      if (hours.length === HOURS) break;
    }
    this._show({
      place: info.get_location_name(), temp: this._shellTemp(info), summary, range: '',
      icon: info.get_symbolic_icon_name(), hours, credit: '',
    });
  }

  private _startOpenMeteo(): void {
    this._stopOpenMeteo();
    this._session ??= new Soup.Session({ user_agent: USER_AGENT, timeout: 20 });
    this._cancellable = new Gio.Cancellable();
    this._fetchOpenMeteo(this._cancellable);
    this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_S, () => {
      if (this._cancellable) this._fetchOpenMeteo(this._cancellable);
      return GLib.SOURCE_CONTINUE;
    });
  }

  private _stopOpenMeteo(): void {
    this._cancellable?.cancel();
    this._cancellable = null;
    if (this._timerId) {
      GLib.Source.remove(this._timerId);
      this._timerId = 0;
    }
  }

  private _getJson(url: string, cancellable: Gio.Cancellable): Promise<any> {
    const message = Soup.Message.new('GET', url);
    return new Promise((resolve, reject) => {
      this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session: any, res: any) => {
        // Throws a GError on a network failure; JSON.parse throws on a bad body.
        try {
          const bytes = session.send_and_read_finish(res);
          if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()}`);
          resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  private async _fetchOpenMeteo(cancellable: Gio.Cancellable): Promise<void> {
    const query = this.env.settings.get_string('weather-location').trim();
    if (!query) {
      this._show('Install GNOME Weather, or type a location in the Liquid Glass preferences');
      return;
    }
    try {
      if (this._geocoded?.query !== query) {
        const found = await this._getJson('https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&name=' +
          encodeURIComponent(query), cancellable);
        const place = found?.results?.[0];
        if (!place) {
          this._show(`No place called “${query}” was found`);
          return;
        }
        this._geocoded = { query, name: place.name, lat: place.latitude, lon: place.longitude };
      }
      const { name, lat, lon } = this._geocoded;
      const fahrenheit = this._unit() === 'fahrenheit' ||
        (this._unit() === 'auto' && /_US\b/.test(GLib.get_language_names()[0] ?? ''));
      const json = await this._getJson('https://api.open-meteo.com/v1/forecast' +
        `?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=2` +
        '&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code,is_day' +
        `&daily=temperature_2m_max,temperature_2m_min${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`,
      cancellable);
      if (cancellable.is_cancelled()) return;
      const current = json.current;
      const [summary, icon] = wmo(current.weather_code, current.is_day === 1);
      // The hourly times are local to the place, as is current.time.
      const start = (json.hourly.time as string[]).findIndex(t => t > current.time);
      const hours: Hour[] = [];
      for (let i = Math.max(start, 0); i < json.hourly.time.length && hours.length < HOURS; i++) {
        const [, hourIcon] = wmo(json.hourly.weather_code[i], json.hourly.is_day[i] === 1);
        hours.push({ label: (json.hourly.time[i] as string).slice(11, 16), icon: hourIcon,
          temp: degrees(json.hourly.temperature_2m[i]) });
      }
      this._show({
        place: name, temp: degrees(current.temperature_2m), summary, icon, hours,
        range: `H ${degrees(json.daily.temperature_2m_max[0])}  L ${degrees(json.daily.temperature_2m_min[0])}`,
        credit: 'Weather data by Open-Meteo.com',
      });
    } catch (e) {
      if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
      this.env.logger.log(`[Liquid Glass] Open-Meteo request failed: ${e}`);
      this._show('Weather is not available right now');
    }
  }

  destroy(): void {
    this._stopOpenMeteo();
    for (const id of this._weatherSettingsIds) this.env.settings.disconnect(id);
    this._weatherSettingsIds = [];
    if (this._client && this._clientId) this._client.disconnect(this._clientId);
    this._client = null;
    this._session?.abort();
    this._session = null;
    super.destroy();
  }
}
