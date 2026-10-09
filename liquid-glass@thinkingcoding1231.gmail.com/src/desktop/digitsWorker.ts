// Makes the glass clock's digits in a process of its own (gjs -m), so the
// shell keeps drawing and following the pointer while they are made. Reads a
// DigitsRequest with an `id` as one line of JSON on stdin, writes the
// texture's pixels to a temporary file and answers with one line on stdout:
// {id, path, width, height, band, digitHeight}, or {id, error}. Exits when
// stdin closes.
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import { DigitsMaker } from './digits.js';

const input = new Gio.DataInputStream({ base_stream: new GioUnix.InputStream({ fd: 0, close_fd: false }) });
const output = new GioUnix.OutputStream({ fd: 1, close_fd: false });
const encoder = new TextEncoder();
const maker = new DigitsMaker();
const loop = new GLib.MainLoop(null, false);

function answer(message: object): void {
  output.write_all(encoder.encode(`${JSON.stringify(message)}\n`), null);
}

function save(bytes: Uint8Array): Promise<string> {
  const [fd, path] = GLib.file_open_tmp('liquid-glass-digits-XXXXXX');
  GLib.close(fd);
  const file = Gio.File.new_for_path(path);
  return new Promise((resolve, reject) => {
    file.replace_contents_bytes_async(new GLib.Bytes(bytes), null, false, Gio.FileCreateFlags.NONE, null, (_f, res) => {
      try {
        file.replace_contents_finish(res);
        resolve(path);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function handle(line: string): Promise<void> {
  let id = 0;
  try {
    const { id: asked, ...request } = JSON.parse(line);
    id = asked;
    const digits = await maker.make(request);
    const path = await save(digits.bytes);
    answer({ id, path, width: digits.width, height: digits.height, band: digits.band, digitHeight: digits.digitHeight });
  } catch (e) {
    answer({ id, error: String(e) });
  }
}

function read(): void {
  input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s, res) => {
    let line: string | null = null;
    try {
      [line] = input.read_line_finish_utf8(res);
    } catch {
      // The shell is gone.
    }
    if (line === null) {
      loop.quit();
      return;
    }
    handle(line);
    read();
  });
}

read();
// runAsync() keeps promises running, which run() blocks in a module still being evaluated.
await loop.runAsync();
