import { promises as fs } from "fs";
import path from "path";
const VIDEO_DIR = process.env.VIDEO_DIR ?? path.join(process.cwd(), "videos");

const exts = new Set([".mkv", ".mov", ".avi"]);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (exts.has(ext)) out.push(full);
  }
  return out;
}

async function fileNewer(a: string, b: string) {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return sa.mtimeMs >= sb.mtimeMs;
  } catch {
    return false;
  }
}

async function runFfmpeg(args: string[]) {
  const proc = Bun.spawn(["ffmpeg", "-y", ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  return code === 0;
}

async function sanityCheck(filePath: string) {
  const probe = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,width,height",
    "-print_format",
    "json",
    filePath,
  ]);
  const out = await new Response(probe.stdout).text();
  const code = await probe.exited;
  if (code !== 0) {
    console.log(`sanity check failed for ${filePath}`);
    return;
  }
  const parsed = JSON.parse(out) as { streams?: Array<any> };
  if (!parsed.streams || parsed.streams.length === 0) {
    console.log(`no video stream found in ${filePath}`);
  }
}

async function getAudioChannels(filePath: string) {
  const probe = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=channels",
    "-print_format",
    "json",
    filePath,
  ]);
  const out = await new Response(probe.stdout).text();
  const code = await probe.exited;
  if (code !== 0) return 0;
  const parsed = JSON.parse(out) as { streams?: Array<{ channels?: number }> };
  return parsed.streams?.[0]?.channels ?? 0;
}

async function getVideoInfo(filePath: string) {
  const probe = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=codec_name,pix_fmt",
    "-print_format",
    "json",
    filePath,
  ]);
  const out = await new Response(probe.stdout).text();
  const code = await probe.exited;
  if (code !== 0) return null;
  const parsed = JSON.parse(out) as { streams?: Array<{ codec_name?: string; pix_fmt?: string }> };
  const stream = parsed.streams?.[0];
  if (!stream) return null;
  return { codec: stream.codec_name ?? "", pixFmt: stream.pix_fmt ?? "" };
}

async function convertOne(inputPath: string, force: boolean) {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  const isWebm = ext === ".webm";
  const isMp4 = ext === ".mp4";
  if (isWebm) return;

  const base = path.basename(inputPath, ext);
  let outputPath = path.join(dir, `${base}.mp4`);
  let tempOutputPath: string | null = null;
  let needsMp4Fix = false;

  if (isMp4) {
    const info = await getVideoInfo(inputPath);
    if (!info) return;
    needsMp4Fix = info.codec !== "h264" || /10/.test(info.pixFmt);
    if (!needsMp4Fix) return;
    if (shouldDelete) {
      tempOutputPath = `${inputPath}.tmp.mp4`;
      outputPath = tempOutputPath;
    } else {
      outputPath = path.join(dir, `${base}.h264.mp4`);
    }
  }

  if (!force && !isMp4 && (await fileNewer(outputPath, inputPath))) {
    const channels = await getAudioChannels(outputPath);
    if (channels > 2) {
      console.log(`re-encode audio to stereo: ${outputPath}`);
    } else {
      console.log(`skip (up-to-date): ${outputPath} (use --force to reconvert)`);
      await sanityCheck(outputPath);
      return;
    }
  }

  try {
    await fs.unlink(outputPath);
  } catch {
    // ignore
  }

  console.log(`convert: ${inputPath}`);

  const fastOk = await runFfmpeg([
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-sn",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    outputPath,
  ]);

  if (!fastOk) {
    console.log(`fallback transcode: ${inputPath}`);
    const ok = await runFfmpeg([
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-sn",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-ac",
      "2",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      outputPath,
    ]);

    if (!ok) {
      throw new Error(`ffmpeg failed for ${inputPath}`);
    }
  }

  await sanityCheck(outputPath);
  if (isMp4 && needsMp4Fix && shouldDelete && tempOutputPath) {
    try {
      await fs.unlink(inputPath);
    } catch {
      // ignore delete errors
    }
    await fs.rename(tempOutputPath, inputPath);
    return;
  }
  if (shouldDelete && !isMp4) {
    try {
      await fs.unlink(inputPath);
    } catch {
      // ignore delete errors
    }
  }
}

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes("--force");
const shouldDelete = rawArgs.includes("--delete");
const args = rawArgs.filter((arg) => arg !== "--" && arg !== "--force" && arg !== "--delete");
const targetDir = args[0] ? path.resolve(VIDEO_DIR, args[0]) : VIDEO_DIR;

try {
  await fs.access(targetDir);
} catch {
  console.log(`folder not found: ${targetDir}`);
  process.exit(1);
}

const files = await walk(targetDir);
if (files.length === 0) {
  console.log(`no convertible files in ${VIDEO_DIR} (use --force to reconvert)`);
  process.exit(0);
}

for (const file of files) {
  await convertOne(file, force);
}
