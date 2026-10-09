// Where the glass clock gets its digits from: a worker process
// (digitsWorker.js) that makes them while the shell goes on drawing, started
// on first use. Where gjs cannot be found or the worker keeps failing, they
// are made in the shell instead, a step at a time.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type { Logger } from '../logger.js';
import { type Digits, type DigitsRequest, DigitsMaker } from './digits.js';

// The worker is started again after it exits, at most this many times.
const MAX_STARTS = 3;

interface Waiting {
  resolve: (digits: Digits) => void;
  reject: (error: Error) => void;
}

export class DigitsSource {
  private _process: Gio.Subprocess | null = null;
  private _output: Gio.DataInputStream | null = null;
  private _waiting = new Map<number, Waiting>();
  // Lines for the worker, written one after another.
  private _lines: string[] = [];
  private _writing = false;
  private _nextId = 1;
  private _starts = 0;
  private _local: DigitsMaker | null = null;
  private _cancellable = new Gio.Cancellable();
  private _encoder = new TextEncoder();

  constructor(private _extensionPath: string, private _logger: Logger) {}

  /** Rejects when the digits cannot be made. */
  make(request: DigitsRequest): Promise<Digits> {
    if (!this._process && !this._local) this._start();
    if (this._local) return this._local.make(request);
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._waiting.set(id, { resolve, reject });
      this._lines.push(`${JSON.stringify({ id, ...request })}\n`);
      this._write();
    });
  }

  private _start(): void {
    const gjs = GLib.find_program_in_path('gjs');
    if (gjs && this._starts < MAX_STARTS) {
      this._starts++;
      try {
        this._process = Gio.Subprocess.new([gjs, '-m', `${this._extensionPath}/dist/desktop/digitsWorker.js`],
          Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._output = new Gio.DataInputStream({ base_stream: this._process.get_stdout_pipe()! });
        this._read();
        return;
      } catch (e) {
        this._logger.log(`[Liquid Glass] Could not start the clock's worker: ${e}`);
        this._process = null;
      }
    }
    this._logger.log('[Liquid Glass] The clock\'s digits are made in the shell');
    this._local = new DigitsMaker();
  }

  private _write(): void {
    const process = this._process;
    if (this._writing || !process || !this._lines.length) return;
    this._writing = true;
    const bytes = new GLib.Bytes(this._encoder.encode(this._lines.shift()!));
    process.get_stdin_pipe()!.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, res) => {
      this._writing = false;
      try {
        stream!.write_bytes_finish(res);
      } catch (e) {
        if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))) this._lost(process, e);
        return;
      }
      this._write();
    });
  }

  private _read(): void {
    const process = this._process!;
    const output = this._output!;
    output.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_s, res) => {
      let line: string | null;
      try {
        [line] = output.read_line_finish_utf8(res);
      } catch (e) {
        if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))) this._lost(process, e);
        return;
      }
      if (line === null) {
        this._lost(process, new Error('the worker exited'));
        return;
      }
      this._answer(line);
      this._read();
    });
  }

  private _answer(line: string): void {
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      this._logger.log(`[Liquid Glass] The clock's worker said something else: ${e}`);
      return;
    }
    const waiting = this._waiting.get(message.id);
    if (!waiting) return;
    this._waiting.delete(message.id);
    if (message.error) {
      waiting.reject(new Error(message.error));
      return;
    }
    const file = Gio.File.new_for_path(message.path);
    file.load_contents_async(this._cancellable, (_f, res) => {
      let bytes;
      try {
        bytes = file.load_contents_finish(res)[1];
      } catch (e) {
        waiting.reject(e as Error);
        return;
      } finally {
        file.delete_async(GLib.PRIORITY_DEFAULT, null, (_f2, res2) => {
          // Throws a GError when the file is already gone; nothing is left behind then.
          try {
            file.delete_finish(res2);
          } catch {
          }
        });
      }
      waiting.resolve({ bytes, width: message.width, height: message.height, band: message.band,
        digitHeight: message.digitHeight });
    });
  }

  // The worker exited or its pipes broke: what it was making is made again.
  private _lost(process: Gio.Subprocess, error: unknown): void {
    if (this._process !== process) return;
    this._logger.log(`[Liquid Glass] Lost the clock's worker: ${error}`);
    process.force_exit();
    this._process = null;
    this._output = null;
    this._lines = [];
    this._writing = false;
    for (const waiting of this._waiting.values()) waiting.reject(new Error('the clock\'s worker exited'));
    this._waiting.clear();
  }

  destroy(): void {
    this._cancellable.cancel();
    this._process?.force_exit();
    this._process = null;
    this._output = null;
    this._waiting.clear();
    this._local?.destroy();
    this._local = null;
  }
}
