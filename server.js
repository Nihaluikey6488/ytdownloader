import express from 'express';
import cors from 'cors';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ytDlp = require('youtube-dl-exec');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_HTML_PATH = path.join(DIST_DIR, 'index.html');

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
const SUPPORTED_FORMATS = new Set(['mp3', 'mp4']);
const SUPPORTED_VIDEO_QUALITIES = new Set(['best', '1080', '720', '480', '360']);
const SUPPORTED_AUDIO_QUALITIES = new Set(['best', '320', '192', '128']);

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

const resolveFfmpegPath = () => {
  const configuredPath = process.env.FFMPEG_PATH?.trim();
  if (configuredPath && existsSync(configuredPath)) {
    return configuredPath;
  }

  const pathResult = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (pathResult.status === 0) {
    return 'ffmpeg';
  }

  return findWinGetFfmpeg();
};

const FFMPEG_PATH = resolveFfmpegPath();
const hasFfmpeg = () => Boolean(FFMPEG_PATH);

const cleanupDirectory = async directoryPath => {
  if (!directoryPath) {
    return;
  }

  await rm(directoryPath, { recursive: true, force: true });
};

const findDownloadedFile = async directoryPath => {
  const files = await readdir(directoryPath, { withFileTypes: true });
  const fileEntry = files.find(
    entry =>
      entry.isFile() &&
      !entry.name.endsWith('.part') &&
      !entry.name.endsWith('.ytdl'),
  );

  return fileEntry ? path.join(directoryPath, fileEntry.name) : null;
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
      ? 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best'
      : 'b[ext=mp4]/best';
  }

  return hasFfmpeg()
    ? `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}][ext=mp4]/bv*[height<=${quality}]+ba/b[height<=${quality}]/best[height<=${quality}]`
    : `b[height<=${quality}][ext=mp4]/best[height<=${quality}][ext=mp4]/b[height<=${quality}]/best[height<=${quality}]`;
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
      message: 'MP3 conversion requires ffmpeg to be installed on the server.',
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
    res.status(status).json({ error: message });
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
      error: 'MP3 conversion is unavailable because ffmpeg is not installed on the server.',
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
            ffmpegLocation: FFMPEG_PATH,
            output: outputTemplate,
            noWarnings: true,
          }
        : {
            format: createVideoFormatSelector(requestedQuality),
            mergeOutputFormat: hasFfmpeg() ? 'mp4' : undefined,
            ffmpegLocation: FFMPEG_PATH || undefined,
            output: outputTemplate,
            noWarnings: true,
          };

    await ytDlp(normalizedUrl, ytDlpFlags);

    const downloadedFile = await findDownloadedFile(tempDir);
    if (!downloadedFile) {
      throw new Error('Downloaded file was not created.');
    }

    const actualExtension = path.extname(downloadedFile).replace('.', '') || format;
    const safeTitle = sanitizeFileName(info.title);
    const qualitySuffix =
      format === 'mp4' && requestedQuality !== 'best'
        ? `-${requestedQuality}p`
        : format === 'mp3' && requestedQuality !== 'best'
          ? `-${requestedQuality}kbps`
          : '';
    const fileName = `${safeTitle}${qualitySuffix}.${actualExtension}`;

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
    res.status(status).json({ error: message });
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
