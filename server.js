import express from 'express';
import cors from 'cors';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ytDlpPackage = require('youtube-dl-exec');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');
const configuredYtDlpPath = process.env.YT_DLP_PATH?.trim();
const ytDlpBinaryPath =
  configuredYtDlpPath ||
  ytDlpPackage.constants?.YOUTUBE_DL_PATH ||
  'yt-dlp';
const ytDlp = configuredYtDlpPath
  ? ytDlpPackage.create(configuredYtDlpPath)
  : ytDlpPackage;

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const SUPPORTED_FORMATS = new Set(['mp3', 'mp4']);
const SUPPORTED_VIDEO_QUALITIES = new Set(['best', '1080', '720', '480', '360']);
const SUPPORTED_AUDIO_QUALITIES = new Set(['best', '320', '192', '128']);
const CONTENT_TYPE_BY_EXTENSION = {
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  webm: 'video/webm',
};

const corsOrigins = CORS_ORIGIN
  ? CORS_ORIGIN.split(',').map(origin => origin.trim()).filter(Boolean)
  : true;

app.use(cors({
  origin: corsOrigins,
  exposedHeaders: ['Content-Disposition', 'X-Download-Filename'],
}));
app.use(express.json());

const sanitizeFileName = (value = 'video') =>
  value
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim() || 'video';

const normalizeYouTubeUrl = (value = '') => {
  const trimmedValue = value.trim();

  try {
    const parsedUrl = new URL(trimmedValue);
    const hostname = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();

    if (hostname === 'youtu.be') {
      const videoId = parsedUrl.pathname.replace(/\//g, '');
      if (!videoId) {
        return null;
      }

      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      return trimmedValue;
    }
  } catch {
    return null;
  }

  return null;
};

const findWinGetFfmpeg = () => {
  const localRoots = [
    process.env.LOCALAPPDATA,
    path.join(os.homedir(), 'AppData', 'Local'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null,
  ].filter(Boolean);

  for (const localRoot of localRoots) {
    const winGetPackagesDir = path.join(localRoot, 'Microsoft', 'WinGet', 'Packages');
    if (!existsSync(winGetPackagesDir)) {
      continue;
    }

    const packageDirs = readdirSync(winGetPackagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('Gyan.FFmpeg'))
      .map(entry => path.join(winGetPackagesDir, entry.name));

    for (const packageDir of packageDirs) {
      const buildDirs = readdirSync(packageDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(packageDir, entry.name));

      for (const buildDir of buildDirs) {
        const candidatePath = path.join(buildDir, 'bin', 'ffmpeg.exe');
        if (existsSync(candidatePath)) {
          return candidatePath;
        }
      }
    }
  }

  return null;
};

const findExecutableOnPath = executableName => {
  const locatorCommand = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(locatorCommand, [executableName], { encoding: 'utf8' });

  if (result.status !== 0) {
    return null;
  }

  return result.stdout
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(Boolean) || null;
};

const resolveFfmpegPath = () => {
  const configuredPath = process.env.FFMPEG_PATH?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  const pathResult = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (pathResult.status === 0) {
    return findExecutableOnPath('ffmpeg') || 'ffmpeg';
  }

  return findWinGetFfmpeg();
};

const FFMPEG_PATH = resolveFfmpegPath();
const FFMPEG_LOCATION = FFMPEG_PATH ? path.dirname(FFMPEG_PATH) : null;
const hasFfmpeg = () => Boolean(FFMPEG_PATH);
const FFPROBE_PATH = !FFMPEG_PATH
  ? null
  : FFMPEG_PATH === 'ffmpeg'
    ? 'ffprobe'
    : path.join(
        path.dirname(FFMPEG_PATH),
        `ffprobe${path.extname(FFMPEG_PATH)}`,
      );

const runProcess = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });

const runProcessForOutput = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });

const runYtDlpDownload = async (url, flags) => {
  await runProcess(ytDlpBinaryPath, [...ytDlpPackage.args(flags), url]);
};

const AUDIO_CODECS_SUPPORTED_IN_MP4 = new Set(['aac']);
const VIDEO_CODECS_SUPPORTED_IN_MP4 = new Set(['h264']);

const cleanupDirectory = async directoryPath => {
  if (!directoryPath) {
    return;
  }

  await rm(directoryPath, { recursive: true, force: true });
};

const findDownloadedFiles = async directoryPath => {
  const files = await readdir(directoryPath, { withFileTypes: true });
  return files
    .filter(
      entry =>
        entry.isFile() &&
        !entry.name.endsWith('.part') &&
        !entry.name.endsWith('.ytdl'),
    )
    .map(entry => path.join(directoryPath, entry.name));
};

const pickPrimaryDownloadedFile = filePaths => {
  const preferredFilePath =
    filePaths.find(filePath => !/\.f\d+\./i.test(path.basename(filePath))) ||
    filePaths[0] ||
    null;

  return preferredFilePath;
};

const getMediaStreamKinds = async filePath => {
  if (!FFPROBE_PATH) {
    return [];
  }

  const { stdout } = await runProcessForOutput(FFPROBE_PATH, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);

  return stdout
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
};

const getMediaInfo = async filePath => {
  if (!FFPROBE_PATH) {
    return { streams: [] };
  }

  const { stdout } = await runProcessForOutput(FFPROBE_PATH, [
    '-v',
    'error',
    '-show_entries',
    'stream=index,codec_name,codec_type,pix_fmt',
    '-of',
    'json',
    filePath,
  ]);

  return JSON.parse(stdout);
};

const findStreamFile = async (filePaths, kind) => {
  for (const filePath of filePaths) {
    const streamKinds = await getMediaStreamKinds(filePath);
    if (streamKinds.includes(kind)) {
      return filePath;
    }
  }

  return null;
};

const createCompatibleMp4FromSources = async (videoPath, audioPath, directoryPath) => {
  const outputPath = path.join(directoryPath, 'compatible-output.mp4');
  const videoInfo = await getMediaInfo(videoPath);
  const audioInfo = await getMediaInfo(audioPath);
  const videoStream = videoInfo.streams?.find(stream => stream.codec_type === 'video');
  const audioStream = audioInfo.streams?.find(stream => stream.codec_type === 'audio');
  const canCopyVideo =
    videoStream &&
    VIDEO_CODECS_SUPPORTED_IN_MP4.has(videoStream.codec_name) &&
    videoStream.pix_fmt === 'yuv420p';
  const canCopyAudio =
    audioStream &&
    AUDIO_CODECS_SUPPORTED_IN_MP4.has(audioStream.codec_name);

  await runProcess(FFMPEG_PATH, [
    '-y',
    '-i',
    videoPath,
    '-i',
    audioPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    canCopyVideo ? 'copy' : 'libx264',
    ...(canCopyVideo
      ? []
      : [
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
        ]),
    '-c:a',
    canCopyAudio ? 'copy' : 'aac',
    ...(canCopyAudio ? [] : ['-b:a', '192k']),
    '-movflags',
    '+faststart',
    outputPath,
  ]);

  return outputPath;
};

const findDownloadedFile = async directoryPath => {
  const filePaths = await findDownloadedFiles(directoryPath);
  const primaryFilePath = pickPrimaryDownloadedFile(filePaths);

  return primaryFilePath;
};

const resolveVideoDownloadPath = async directoryPath => {
  const filePaths = await findDownloadedFiles(directoryPath);
  const primaryFilePath = pickPrimaryDownloadedFile(filePaths);

  if (primaryFilePath && !/\.f\d+\./i.test(path.basename(primaryFilePath))) {
    return createCompatibleMp4(primaryFilePath, directoryPath);
  }

  const videoFilePath = await findStreamFile(filePaths, 'video');
  const audioFilePath = await findStreamFile(
    filePaths.filter(filePath => filePath !== videoFilePath),
    'audio',
  );

  if (videoFilePath && audioFilePath) {
    return createCompatibleMp4FromSources(videoFilePath, audioFilePath, directoryPath);
  }

  if (primaryFilePath) {
    return createCompatibleMp4(primaryFilePath, directoryPath);
  }

  return null;
};

const createCompatibleMp4 = async (inputPath, directoryPath) => {
  const outputPath = path.join(directoryPath, 'compatible-output.mp4');
  const mediaInfo = await getMediaInfo(inputPath);
  const videoStream = mediaInfo.streams?.find(stream => stream.codec_type === 'video');
  const audioStream = mediaInfo.streams?.find(stream => stream.codec_type === 'audio');
  const canCopyVideo =
    videoStream &&
    VIDEO_CODECS_SUPPORTED_IN_MP4.has(videoStream.codec_name) &&
    videoStream.pix_fmt === 'yuv420p';
  const canCopyAudio =
    audioStream &&
    AUDIO_CODECS_SUPPORTED_IN_MP4.has(audioStream.codec_name);

  await runProcess(FFMPEG_PATH, [
    '-y',
    '-i',
    inputPath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    canCopyVideo ? 'copy' : 'libx264',
    ...(canCopyVideo
      ? []
      : [
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-pix_fmt',
          'yuv420p',
        ]),
    '-c:a',
    canCopyAudio ? 'copy' : 'aac',
    ...(canCopyAudio ? [] : ['-b:a', '192k']),
    '-movflags',
    '+faststart',
    outputPath,
  ]);

  return outputPath;
};

const getRequestedQuality = (format, quality) => {
  const normalizedQuality = String(quality || 'best');

  if (format === 'mp4') {
    return SUPPORTED_VIDEO_QUALITIES.has(normalizedQuality)
      ? normalizedQuality
      : null;
  }

  return SUPPORTED_AUDIO_QUALITIES.has(normalizedQuality)
    ? normalizedQuality
    : null;
};

const createVideoFormatSelector = quality => {
  if (quality === 'best') {
    return hasFfmpeg()
      ? 'bv*[vcodec!=none]+ba[acodec!=none]/b[vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]'
      : 'b[ext=mp4][vcodec!=none][acodec!=none]/best[ext=mp4][vcodec!=none][acodec!=none]/b[vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]';
  }

  return hasFfmpeg()
    ? `bv*[height<=${quality}][vcodec!=none]+ba[acodec!=none]/b[height<=${quality}][vcodec!=none][acodec!=none]/best[height<=${quality}][vcodec!=none][acodec!=none]`
    : `b[height<=${quality}][ext=mp4][vcodec!=none][acodec!=none]/best[height<=${quality}][ext=mp4][vcodec!=none][acodec!=none]/b[height<=${quality}][vcodec!=none][acodec!=none]/best[height<=${quality}][vcodec!=none][acodec!=none]`;
};

const pickThumbnail = info => {
  if (typeof info.thumbnail === 'string' && info.thumbnail) {
    return info.thumbnail;
  }

  if (!Array.isArray(info.thumbnails) || info.thumbnails.length === 0) {
    return '';
  }

  const sortedThumbnails = [...info.thumbnails].sort(
    (left, right) => (right.width || 0) - (left.width || 0),
  );

  return sortedThumbnails[0]?.url || '';
};

const serializeVideoInfo = info => ({
  id: info.id || '',
  title: info.title || 'Untitled video',
  uploader: info.uploader || info.channel || 'Unknown channel',
  duration: Number.isFinite(info.duration) ? info.duration : null,
  thumbnail: pickThumbnail(info),
  viewCount: Number.isFinite(info.view_count) ? info.view_count : null,
  webpageUrl: info.webpage_url || '',
});

const fetchVideoInfo = normalizedUrl =>
  ytDlp(normalizedUrl, {
    dumpSingleJson: true,
    noWarnings: true,
  });

const createDownloadError = (details = '') => {
  const trimmedDetails = details.trim();

  if (trimmedDetails.includes('ffmpeg not found')) {
    return {
      status: 503,
      message: 'This server is missing ffmpeg, which is required for MP3 conversion and reliable MP4 audio/video output.',
    };
  }

  if (trimmedDetails.includes('Video unavailable')) {
    return {
      status: 404,
      message: 'This video is unavailable or cannot be downloaded right now.',
    };
  }

  return {
    status: 500,
    message: 'Failed to download the requested video.',
  };
};

const createErrorPayload = (message, details = '') =>
  process.env.NODE_ENV === 'production' || !details
    ? { error: message }
    : { error: message, details };

app.get('/api/health', (req, res) => {
  res.json({
    message: `YouTube Downloader Backend is running. Frontend: ${FRONTEND_URL}`,
    ffmpegInstalled: hasFfmpeg(),
    ffmpegPath: FFMPEG_PATH,
  });
});

app.get('/api/info', async (req, res) => {
  const normalizedUrl = normalizeYouTubeUrl(String(req.query.url || ''));

  if (!normalizedUrl) {
    return res.status(400).json({ error: 'Please enter a valid YouTube URL.' });
  }

  try {
    const info = await fetchVideoInfo(normalizedUrl);
    res.json(serializeVideoInfo(info));
  } catch (error) {
    const details = error?.stderr || error?.message || '';
    const { status, message } = createDownloadError(details);

    console.error('Info lookup error:', details || error);
    res.status(status).json(createErrorPayload(message, details));
  }
});

app.get('/api/download', async (req, res) => {
  const { url, format = 'mp4', quality = 'best' } = req.query;
  const normalizedUrl = normalizeYouTubeUrl(String(url || ''));
  const requestedQuality = getRequestedQuality(format, quality);

  if (!normalizedUrl) {
    return res.status(400).json({ error: 'Please enter a valid YouTube URL.' });
  }

  if (!SUPPORTED_FORMATS.has(format)) {
    return res.status(400).json({ error: 'Unsupported format. Use mp4 or mp3.' });
  }

  if (!requestedQuality) {
    return res.status(400).json({
      error: `Unsupported quality for ${format}.`,
    });
  }

  if (format === 'mp3' && !hasFfmpeg()) {
    return res.status(503).json({
      error: 'This server is missing ffmpeg, which is required for MP3 conversion and reliable MP4 audio/video output.',
    });
  }

  if (format === 'mp4' && !hasFfmpeg()) {
    return res.status(503).json({
      error: 'This server is missing ffmpeg, so MP4 downloads may lose audio. Install ffmpeg on the backend and try again.',
    });
  }

  let tempDir = null;

  try {
    const info = await fetchVideoInfo(normalizedUrl);

    tempDir = await mkdtemp(path.join(os.tmpdir(), 'yt-downloader-'));
    const outputTemplate = path.join(tempDir, 'download.%(ext)s');

    const ytDlpFlags =
      format === 'mp3'
        ? {
            extractAudio: true,
            audioFormat: 'mp3',
            audioQuality: requestedQuality === 'best' ? '0' : `${requestedQuality}K`,
            ffmpegLocation: FFMPEG_LOCATION || FFMPEG_PATH,
            concurrentFragments: 4,
            output: outputTemplate,
            noWarnings: true,
          }
        : {
            format: createVideoFormatSelector(requestedQuality),
            mergeOutputFormat: hasFfmpeg() ? 'mkv' : undefined,
            ffmpegLocation: FFMPEG_LOCATION || FFMPEG_PATH || undefined,
            concurrentFragments: 4,
            output: outputTemplate,
            noWarnings: true,
          };

    await runYtDlpDownload(normalizedUrl, ytDlpFlags);

    const rawDownloadedFile = await findDownloadedFile(tempDir);
    if (!rawDownloadedFile) {
      throw new Error('Downloaded file was not created.');
    }

    const downloadedFile =
      format === 'mp4' && hasFfmpeg()
        ? await resolveVideoDownloadPath(tempDir)
        : rawDownloadedFile;

    if (!downloadedFile) {
      throw new Error('Downloaded file was not created.');
    }

    const actualExtension = path.extname(downloadedFile).replace('.', '') || format;
    const safeTitle = sanitizeFileName(info.title);
    const contentType = CONTENT_TYPE_BY_EXTENSION[actualExtension] || 'application/octet-stream';
    const qualitySuffix =
      format === 'mp4' && requestedQuality !== 'best'
        ? `-${requestedQuality}p`
        : format === 'mp3' && requestedQuality !== 'best'
          ? `-${requestedQuality}kbps`
          : '';
    const fileName = `${safeTitle}${qualitySuffix}.${actualExtension}`;

    res.type(contentType);
    res.setHeader('X-Download-Filename', fileName);

    res.download(downloadedFile, fileName, async error => {
      try {
        await cleanupDirectory(tempDir);
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }

      if (error && !res.headersSent) {
        res.status(500).json({ error: 'Failed to send the downloaded file.' });
      }
    });
  } catch (error) {
    const details = error?.stderr || error?.message || '';
    const { status, message } = createDownloadError(details);

    console.error('Download setup error:', details || error);
    await cleanupDirectory(tempDir);
    res.status(status).json(createErrorPayload(message, details));
  }
});

if (existsSync(INDEX_HTML_PATH)) {
  app.use(express.static(DIST_DIR));

  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(INDEX_HTML_PATH);
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
