// Render a lip-synced avatar video offline from a recorded voice file.
// The avatar is drawn frame by frame (manual mode), so the mouth always matches the audio.
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, relative, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { validateRig } from '../packages/runtime/src/rig/validate.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `Usage: npm run render-lipsync -- <project> <audio> [options]

  <audio>             WAV, MP3, OGG or FLAC voice recording (convert others with ffmpeg)
  --format <f>        prores (default; .mov with transparency for DaVinci Resolve),
                      green (.mp4 on a green background) or png (numbered PNG frames)
  --out <path>        output file or folder (default: <project>/video/<audio name>.<ext>)
  --size <px>         square frame size (default 1080)
  --fps <n>           frames per second (default 30)
  --gain <n>          voice level multiplier; raise for quiet recordings (default 1)
  --hold <sec>        keep "speaking" this long after the voice stops (default 0.4)
  --start <sec>       start position in the audio (default 0)
  --duration <sec>    render only this many seconds (default: to the end)
  --expression <name> live expression to hold (e.g. smile, angry, sad, surprise)
  --seed <n>          seed for blinks and idle motion (default 1)
  --no-idle-motion    no small idle motions (doze, sigh, ...); blinks and reactions stay
  --calm              no idle or reaction motions; only sway, breathing and blinks
  --no-half-eyes      never show the half-closed eye drawing (eyes are open or closed)
  --no-audio          do not put the audio into the video file
  --timeline <csv>    timing table from tools/speaker-timeline.py (line,speaker,start,end,text);
                      with --speaker, the avatar talks only during that speaker's lines
  --speaker <name>    speaker name in the timeline (default: the project folder name)
  --margin <sec>      widen each line by this much on both sides (default 0.1)`;

function parseArgs(argv) {
  const opts = { format: 'prores', size: 1080, fps: 30, gain: 1, hold: 0.4, start: 0, duration: null, seed: 1, audio: true, expression: null, out: null, idleMotion: true, reactions: true, timeline: null, speaker: null, margin: 0.1, halfEyes: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    const num = (min) => { const v = Number(value()); if (!Number.isFinite(v) || v < min) throw new Error(`${a}: expected a number >= ${min}`); return v; };
    if (a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '--format') { opts.format = value(); if (!['prores', 'green', 'png'].includes(opts.format)) throw new Error('--format: prores, green or png'); }
    else if (a === '--out') opts.out = value();
    else if (a === '--size') opts.size = Math.round(num(64));
    else if (a === '--fps') opts.fps = num(1);
    else if (a === '--gain') opts.gain = num(0);
    else if (a === '--hold') opts.hold = num(0);
    else if (a === '--start') opts.start = num(0);
    else if (a === '--duration') opts.duration = num(0.1);
    else if (a === '--seed') opts.seed = Math.round(num(0));
    else if (a === '--expression') opts.expression = value();
    else if (a === '--no-audio') opts.audio = false;
    else if (a === '--no-half-eyes') opts.halfEyes = false;
    else if (a === '--no-idle-motion') opts.idleMotion = false;
    else if (a === '--calm') { opts.idleMotion = false; opts.reactions = false; }
    else if (a === '--timeline') opts.timeline = value();
    else if (a === '--speaker') opts.speaker = value();
    else if (a === '--margin') opts.margin = num(0);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 2) throw new Error(USAGE);
  if (opts.speaker && !opts.timeline) throw new Error('--speaker needs --timeline');
  return { ...opts, project: rest[0], audioPath: rest[1] };
}

// Timing table: header line,speaker,start,end,text; text may contain commas.
async function readTimeline(path, speaker) {
  const rows = (await readFile(path, 'utf8')).trimStart().split(/\r?\n/).filter(l => l.trim());
  const head = rows.shift().split(',').map(h => h.trim().toLowerCase());
  const col = name => { const i = head.indexOf(name); if (i < 0) throw new Error(`${path}: missing column "${name}"`); return i; };
  const [cs, cb, ce] = [col('speaker'), col('start'), col('end')];
  const lines = rows.map((row, n) => {
    const f = row.split(',');
    const start = Number(f[cb]), end = Number(f[ce]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error(`${path}: row ${n + 2}: bad start/end`);
    // "a&b" marks a line both speakers say together.
    return { speakers: f[cs].trim().replace(/^"|"$/g, '').split(/\s*[&＆+＋]\s*/).filter(Boolean), start, end };
  });
  const names = [...new Set(lines.flatMap(l => l.speakers))];
  if (!names.includes(speaker)) throw new Error(`speaker "${speaker}" is not in the timeline (found: ${names.join(', ')}); use --speaker`);
  return lines.filter(l => l.speakers.includes(speaker)).map(l => [l.start, l.end]);
}

function ffmpeg(args) {
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, fail) => {
    child.on('error', error => fail(error.code === 'ENOENT' ? new Error('ffmpeg not found; install it or use --format png') : error));
    child.on('close', code => code === 0 ? ok() : fail(new Error(`ffmpeg exited with code ${code}`)));
  });
  return { stdin: child.stdin, done };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const project = await realpath(resolve(opts.project));
  if (relative(root, project).startsWith('..')) throw new Error('project must stay inside the repository');
  const audioPath = await realpath(resolve(opts.audioPath));
  if (!(await stat(audioPath)).isFile()) throw new Error(`not a file: ${opts.audioPath}`);
  const rig = JSON.parse(await readFile(resolve(project, 'rig.json'), 'utf8'));
  const errors = validateRig(rig);
  if (errors.length) throw new Error(errors.join('\n'));
  let lipSync;
  try { lipSync = JSON.parse(await readFile(resolve(project, 'avatar.json'), 'utf8')).lipSync; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const speaker = opts.speaker ?? basename(project);
  const segments = opts.timeline ? await readTimeline(resolve(opts.timeline), speaker) : null;
  if (segments) console.log(`Timeline: ${segments.length} lines for ${speaker}`);

  // Output stays inside the project, like every other derived file.
  const ext = { prores: '.mov', green: '.mp4', png: '' }[opts.format];
  const out = resolve(opts.out ?? resolve(project, 'video', basename(audioPath, extname(audioPath)) + (segments ? `.${speaker}` : '') + ext));
  await mkdir(opts.format === 'png' ? out : dirname(out), { recursive: true });
  if (relative(project, await realpath(opts.format === 'png' ? out : dirname(out))).startsWith('..')) throw new Error('output must stay inside the project folder');

  const built = await realpath(resolve(project, 'built'));
  const assets = {};
  async function asset(name) {
    const path = await realpath(resolve(built, name));
    if (relative(built, path).startsWith('..')) throw new Error(`asset escapes built folder: ${name}`);
    assets[name] = `data:${name.endsWith('.png') ? 'image/png' : 'application/json'};base64,${(await readFile(path)).toString('base64')}`;
  }
  await asset('layers.json');
  const layers = JSON.parse(await readFile(resolve(built, 'layers.json'), 'utf8'));
  await Promise.all(['base', 'hairmask', ...Object.keys(layers.layers)].map(name => asset(`${name}.png`)));
  try {
    await asset('sprites/sprites.json');
    const sprites = JSON.parse(await readFile(resolve(built, 'sprites/sprites.json'), 'utf8'));
    await Promise.all(Object.keys(sprites.layers).map(name => asset(`sprites/${name}.png`)));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const server = await createServer({ root, configFile: false, publicDir: false, appType: 'custom', cacheDir: 'node_modules/.vite-pose-review', optimizeDeps: { noDiscovery: true, entries: [] },
    plugins: [{ name: 'lipsync-render-page', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/__lipsync__') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body style="margin:0;background:transparent"><canvas id="avatar"></canvas></body></html>'); return; }
        // The voice file is served only to the local page; it never leaves this machine.
        if (req.url === '/__lipsync_audio__') { res.setHeader('Content-Type', 'application/octet-stream'); createReadStream(audioPath).pipe(res); return; }
        next();
      });
    } }],
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, preTransformRequests: false }, logLevel: 'error' });
  let browser, encoder;
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: opts.size, height: opts.size }, deviceScaleFactor: 1 });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/__lipsync__`);

    const info = await page.evaluate(async ({ rig, assets, opts, lipSync, segments }) => {
      // Seeded randomness so blinks and idle motion repeat for the same seed.
      let s = (opts.seed >>> 0) || 1;
      Math.random = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
      const buffer = await (await fetch('/__lipsync_audio__')).arrayBuffer();
      let decoded;
      try { decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(buffer); }
      catch { throw new Error('cannot decode the audio; convert it to WAV (ffmpeg -i in.m4a out.wav)'); }
      const rate = decoded.sampleRate, n = decoded.length;
      const mono = new Float32Array(n);
      for (let c = 0; c < decoded.numberOfChannels; c++) { const d = decoded.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / decoded.numberOfChannels; }
      const total = n / rate;
      const start = Math.min(opts.start, total);
      const length = Math.max(0, Math.min(total - start, opts.duration ?? Infinity));
      const frames = Math.max(1, Math.ceil(length * opts.fps));
      // Same loudness measure as the editor's audio preview: RMS of the latest 1024 samples at 48 kHz.
      const win = 1024, levels = new Float32Array(frames);
      for (let f = 0; f < frames; f++) {
        const end = Math.floor((start + (f + 1) / opts.fps) * rate);
        let sum = 0, count = 0;
        for (let i = Math.max(0, end - win); i < Math.min(n, end); i++) { sum += mono[i] * mono[i]; count++; }
        const rms = count ? Math.sqrt(sum / count) : 0;
        levels[f] = Math.min(1, Math.max(0, (rms - 0.008) * Math.min(10, opts.gain) * 5));
      }
      // Dialogue: keep only this speaker's lines; the other voice leaves the mouth closed.
      if (segments) for (let f = 0; f < frames; f++) {
        const t = start + (f + 1) / opts.fps;
        if (!segments.some(([a, b]) => t >= a - opts.margin && t <= b + opts.margin)) levels[f] = 0;
      }
      // Speaking pauses idle motion and nods with the voice; release it in longer silences.
      const speaking = new Uint8Array(frames), holdFrames = Math.round(opts.hold * opts.fps);
      let last = -Infinity;
      for (let f = 0; f < frames; f++) { if (levels[f] > 0.02) last = f; speaking[f] = f - last <= holdFrames ? 1 : 0; }
      for (let f = frames - 1, next = Infinity; f >= 0; f--) { if (levels[f] > 0.02) next = f; if (next - f <= 2) speaking[f] = 1; }

      const { createMeshAvatar } = await import('/packages/runtime/src/index.ts');
      const canvas = document.getElementById('avatar');
      canvas.style.width = `${opts.size}px`; canvas.style.height = `${opts.size}px`;
      const av = await createMeshAvatar(canvas, { rig, assets, manual: true, halfEyes: opts.halfEyes, ...(lipSync ? { lipSync } : {}) });
      av.setAutoIdle(opts.idleMotion); av.setAutoMotion(opts.reactions);
      if (opts.expression) av.setExpression(opts.expression);
      av.advance(1, 60); // settle hair physics before the first frame
      window.__render = { av, canvas, levels, speaking };
      return { frames, seconds: length, start, rate, voiced: speaking.reduce((a, b) => a + b, 0) / frames };
    }, { rig, assets, opts, lipSync, segments });
    if (browserErrors.length) throw new Error(browserErrors.join('\n'));

    const { frames } = info;
    console.log(`Audio: ${info.seconds.toFixed(2)} s from ${info.start.toFixed(2)} s, ${frames} frames at ${opts.fps} fps, speaking ${(info.voiced * 100).toFixed(0)}% of the time`);
    const audioArgs = opts.audio && opts.format !== 'png' ? ['-ss', String(info.start), '-t', String(info.seconds), '-i', audioPath] : [];
    const video = ['-f', 'image2pipe', '-c:v', 'png', '-framerate', String(opts.fps), '-i', '-'];
    if (opts.format === 'prores') encoder = ffmpeg([...video, ...audioArgs, '-map', '0:v', ...(audioArgs.length ? ['-map', '1:a', '-c:a', 'pcm_s16le'] : []),
      '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-qscale:v', '9', '-vendor', 'apl0', '-shortest', out]);
    else if (opts.format === 'green') encoder = ffmpeg(['-f', 'lavfi', '-i', `color=c=0x00b140:s=${opts.size}x${opts.size}:r=${opts.fps}`, ...video, ...audioArgs,
      '-filter_complex', '[0:v][1:v]overlay=shortest=1:format=auto,format=yuv420p[v]', '-map', '[v]', ...(audioArgs.length ? ['-map', '2:a', '-c:a', 'aac', '-b:a', '192k'] : []),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-shortest', out]);

    const batch = 30, started = Date.now();
    for (let f = 0; f < frames; f += batch) {
      const pngs = await page.evaluate(({ from, to, fps }) => {
        const { av, canvas, levels, speaking } = window.__render, outFrames = [];
        for (let i = from; i < to; i++) {
          av.setSpeaking(!!speaking[i]); av.setVoiceLevel(speaking[i] ? levels[i] : 0);
          av.advance(1 / fps, fps * 2); // two physics steps per frame
          outFrames.push(canvas.toDataURL('image/png').split(',')[1]);
        }
        return outFrames;
      }, { from: f, to: Math.min(frames, f + batch), fps: opts.fps });
      if (browserErrors.length) throw new Error(browserErrors.join('\n'));
      for (const [k, data] of pngs.entries()) {
        const buffer = Buffer.from(data, 'base64');
        if (encoder) { if (!encoder.stdin.write(buffer)) await new Promise(ok => encoder.stdin.once('drain', ok)); }
        else await writeFile(resolve(out, `frame_${String(f + k + 1).padStart(6, '0')}.png`), buffer);
      }
      const doneFrames = Math.min(frames, f + batch), elapsed = (Date.now() - started) / 1000;
      process.stdout.write(`\r${doneFrames}/${frames} frames (${(doneFrames / elapsed).toFixed(1)} fps, about ${Math.ceil((frames - doneFrames) / (doneFrames / elapsed))} s left)   `);
    }
    process.stdout.write('\n');
    if (encoder) { encoder.stdin.end(); await encoder.done; }
    console.log(`Wrote ${relative(root, out)}${opts.format === 'png' ? `/ (${frames} PNG frames; add the audio separately)` : ''}`);
  } finally {
    if (encoder && !encoder.stdin.writableEnded) encoder.stdin.destroy();
    await browser?.close();
    await server.close();
  }
}

main().catch(error => { console.error(`render-lipsync: ${error.message}`); process.exitCode = 1; });
