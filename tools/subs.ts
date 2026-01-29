import { promises as fs } from "fs";
import path from "path";

const VIDEO_DIR = process.env.VIDEO_DIR ?? path.join(process.cwd(), "videos");
const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".avi"]);
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".tar.gz", ".tgz"]);

async function run(cmd: string, args: string[]) {
  const proc = Bun.spawn([cmd, ...args], { stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  return code === 0;
}

function isArchive(filename: string) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return true;
  const ext = path.extname(lower);
  return ARCHIVE_EXTS.has(ext);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: any[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(full);
  }
  return out;
}

async function extractArchive(filePath: string) {
  const dir = path.dirname(filePath);
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    console.log(`extract zip: ${filePath}`);
    await run("unzip", ["-o", filePath, "-d", dir]);
    return;
  }
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) {
    console.log(`extract tar.gz: ${filePath}`);
    await run("tar", ["-xzf", filePath, "-C", dir]);
    return;
  }
  if (lower.endsWith(".tar")) {
    console.log(`extract tar: ${filePath}`);
    await run("tar", ["-xf", filePath, "-C", dir]);
  }
}

async function extractArchives(root: string) {
  const files = await walk(root);
  for (const file of files) {
    if (!isArchive(file)) continue;
    await extractArchive(file);
  }
}

async function ensureVideoFolders(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const groups = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    const base = path.basename(entry.name, ext);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base)!.push(entry.name);
  }

  for (const [base, files] of groups.entries()) {
    const hasVideo = files.some((name) => VIDEO_EXTS.has(path.extname(name).toLowerCase()));
    if (!hasVideo) continue;
    const destDir = path.join(root, base);
    await fs.mkdir(destDir, { recursive: true });
    for (const name of files) {
      const src = path.join(root, name);
      const dest = path.join(destDir, name);
      try {
        await fs.rename(src, dest);
      } catch {
        // ignore move errors (already moved or conflicts)
      }
    }
  }
}

async function findVideoFiles(root: string) {
  const files = await walk(root);
  return files.filter((file) => VIDEO_EXTS.has(path.extname(file).toLowerCase()));
}

async function runFfmpeg(args: string[]) {
  return run("ffmpeg", ["-y", ...args]);
}

async function extractForFile(inputPath: string) {
  const dir = path.dirname(inputPath);
  const probe = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "s",
    "-show_streams",
    "-print_format",
    "json",
    inputPath,
  ]);
  const out = await new Response(probe.stdout).text();
  const err = await new Response(probe.stderr).text();
  const code = await probe.exited;
  if (code !== 0) {
    console.log(`ffprobe failed: ${err}`);
    return;
  }

  const parsed = JSON.parse(out) as { streams?: Array<any> };
  const streams = parsed.streams ?? [];
  if (streams.length === 0) {
    return;
  }

  for (const stream of streams) {
    const globalIndex = stream.index as number;
    const codec = String(stream.codec_name || "");
    if (!["subrip", "ass", "ssa", "webvtt"].includes(codec)) {
      continue;
    }
    const lang = stream.tags?.language ?? "und";
    const outFile = path.join(dir, `sub_${globalIndex}_${lang}.vtt`);
    const ok = await runFfmpeg(["-i", inputPath, "-map", `0:${globalIndex}`, outFile]);
    if (!ok) {
      console.log(`failed to extract subtitle stream ${globalIndex} (${lang})`);
    }
  }
}

const rawArgs = process.argv.slice(2);
const args = rawArgs.filter((arg) => arg !== "--" && arg !== "--force");
const targetDir = args[0] ? path.resolve(VIDEO_DIR, args[0]) : VIDEO_DIR;

try {
  await fs.access(targetDir);
} catch {
  console.log(`folder not found: ${targetDir}`);
  process.exit(1);
}

await fs.mkdir(targetDir, { recursive: true });
await extractArchives(targetDir);
await ensureVideoFolders(targetDir);

const videoFiles = await findVideoFiles(targetDir);
if (videoFiles.length === 0) {
  console.log(`no video files in ${targetDir}`);
  process.exit(0);
}

const byDir = new Map<string, string[]>();
for (const file of videoFiles) {
  const parent = path.dirname(file);
  if (!byDir.has(parent)) byDir.set(parent, []);
  byDir.get(parent)!.push(file);
}

for (const files of byDir.values()) {
  files.sort();
  await extractForFile(files[0]);
}
