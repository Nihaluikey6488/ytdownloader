import { useEffect, useState } from 'react'
import './App.css'

const YOUTUBE_HOSTS = new Set(['youtube.com', 'm.youtube.com', 'youtu.be'])
const NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const QUALITY_OPTIONS = {
  mp4: [
    { value: 'best', label: 'Best available' },
    { value: '1080', label: '1080p' },
    { value: '720', label: '720p' },
    { value: '480', label: '480p' },
    { value: '360', label: '360p' },
  ],
  mp3: [
    { value: 'best', label: 'Best available' },
    { value: '320', label: '320 kbps' },
    { value: '192', label: '192 kbps' },
    { value: '128', label: '128 kbps' },
  ],
}

const isValidYouTubeUrl = (value) => {
  try {
    const parsedUrl = new URL(value.trim())
    const hostname = parsedUrl.hostname.replace(/^www\./, '').toLowerCase()

    return YOUTUBE_HOSTS.has(hostname)
  } catch {
    return false
  }
}

const getFileNameFromHeaders = (response, fallbackExtension) => {
  const customHeader = response.headers.get('x-download-filename')
  if (customHeader) {
    return customHeader
  }

  const disposition = response.headers.get('content-disposition')
  const fileNameMatch = disposition?.match(/filename="([^"]+)"/i)

  return fileNameMatch?.[1] || `youtube-download.${fallbackExtension}`
}

const formatDuration = (duration) => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 'Unknown length'
  }

  const hours = Math.floor(duration / 3600)
  const minutes = Math.floor((duration % 3600) / 60)
  const seconds = Math.floor(duration % 60)

  if (hours > 0) {
    return [hours, minutes.toString().padStart(2, '0'), seconds.toString().padStart(2, '0')].join(':')
  }

  return [minutes, seconds.toString().padStart(2, '0')].join(':')
}

const formatViews = (viewCount) => {
  if (!Number.isFinite(viewCount) || viewCount < 0) {
    return 'Views unavailable'
  }

  return `${NUMBER_FORMATTER.format(viewCount)} views`
}

function App() {
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState('mp4')
  const [quality, setQuality] = useState('best')
  const [status, setStatus] = useState('')
  const [statusTone, setStatusTone] = useState('idle')
  const [isDownloading, setIsDownloading] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewStatus, setPreviewStatus] = useState('idle')
  const [previewError, setPreviewError] = useState('')

  useEffect(() => {
    setQuality('best')
  }, [format])

  useEffect(() => {
    const trimmedUrl = url.trim()

    if (!trimmedUrl) {
      setPreview(null)
      setPreviewStatus('idle')
      setPreviewError('')
      return undefined
    }

    if (!isValidYouTubeUrl(trimmedUrl)) {
      setPreview(null)
      setPreviewStatus('idle')
      setPreviewError('')
      return undefined
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      try {
        setPreviewStatus('loading')
        setPreviewError('')

        const response = await fetch(
          `/api/info?url=${encodeURIComponent(trimmedUrl)}`,
          { signal: controller.signal },
        )

        if (!response.ok) {
          const payload = await response.json().catch(() => null)
          throw new Error(payload?.error || 'Preview unavailable right now.')
        }

        const payload = await response.json()
        setPreview(payload)
        setPreviewStatus('ready')
      } catch (error) {
        if (error.name === 'AbortError') {
          return
        }

        setPreview(null)
        setPreviewStatus('error')
        setPreviewError(
          error instanceof TypeError
            ? 'Cannot reach the preview server right now.'
            : error.message || 'Preview unavailable right now.',
        )
      }
    }, 550)

    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [url])

  const handleDownload = async () => {
    if (isDownloading) {
      return
    }

    const trimmedUrl = url.trim()

    if (!trimmedUrl) {
      setStatus('Please enter a YouTube URL.')
      setStatusTone('error')
      return
    }

    if (!isValidYouTubeUrl(trimmedUrl)) {
      setStatus('Please enter a valid YouTube URL.')
      setStatusTone('error')
      return
    }

    try {
      setIsDownloading(true)
      setStatus('Preparing your download...')
      setStatusTone('idle')

      const searchParams = new URLSearchParams({
        url: trimmedUrl,
        format,
        quality,
      })

      const response = await fetch(`/api/download?${searchParams.toString()}`)

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || 'Download failed. Please try again.')
      }

      const downloadBlob = await response.blob()
      const objectUrl = window.URL.createObjectURL(downloadBlob)
      const fileName = getFileNameFromHeaders(response, format)
      const link = document.createElement('a')

      link.href = objectUrl
      link.download = fileName
      document.body.appendChild(link)
      link.click()
      link.remove()

      window.URL.revokeObjectURL(objectUrl)

      setStatus(`Download ready: ${fileName}`)
      setStatusTone('success')
    } catch (error) {
      const message =
        error instanceof TypeError
          ? 'Cannot reach the download server. Start the backend and try again.'
          : error.message || 'Download failed. Please try again.'

      setStatus(message)
      setStatusTone('error')
    } finally {
      setIsDownloading(false)
    }
  }

  const selectedQualityOptions = QUALITY_OPTIONS[format]
  const heroTitle = preview?.title || 'Paste a YouTube link to preview the artwork'
  const heroSubtitle =
    preview?.uploader ||
    'We will pull the title, poster, and download details before you save the file.'

  return (
    <div className="downloader-shell">
      <section className="downloader-card control-panel">
        <div className="panel-topline">
          <p className="eyebrow">React + Express</p>
          <span className="live-pill">Live preview</span>
        </div>

        <h1>YouTube Poster Downloader</h1>
        <p className="subcopy">
          Grab the video or extract the song as MP3 with a cleaner UI, quality
          controls, and an artwork preview before downloading.
        </p>

        <div className="input-group">
          <label htmlFor="url">YouTube URL</label>
          <input
            type="text"
            id="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
          />
        </div>

        <div className="control-grid">
          <div className="input-group">
            <label htmlFor="format">Format</label>
            <select
              id="format"
              value={format}
              onChange={(event) => setFormat(event.target.value)}
            >
              <option value="mp4">Video (MP4)</option>
              <option value="mp3">Audio (MP3)</option>
            </select>
          </div>

          <div className="input-group">
            <label htmlFor="quality">Quality</label>
            <select
              id="quality"
              value={quality}
              onChange={(event) => setQuality(event.target.value)}
            >
              {selectedQualityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="hint-panel">
          <span className="hint-kicker">Download setup</span>
          <p className="hint-text">
            {format === 'mp4'
              ? 'Video quality targets a resolution and falls back gracefully if that exact format is missing.'
              : 'Audio quality controls MP3 bitrate, so higher numbers usually mean bigger files and better fidelity.'}
          </p>
        </div>

        <button
          onClick={handleDownload}
          className="download-btn"
          disabled={isDownloading}
        >
          {isDownloading ? 'Preparing...' : `Download ${format.toUpperCase()}`}
        </button>

        {status && <p className={`status status-${statusTone}`}>{status}</p>}
      </section>

      <section className="downloader-card preview-panel">
        <div className="poster-frame">
          {preview?.thumbnail ? (
            <img
              className="poster-image"
              src={preview.thumbnail}
              alt={preview.title}
            />
          ) : (
            <div className="poster-placeholder">
              <span className="poster-placeholder-badge">
                {previewStatus === 'loading' ? 'Loading...' : 'Poster Preview'}
              </span>
            </div>
          )}
          <div className="poster-overlay" />
        </div>

        <div className="preview-copy">
          <p className="preview-label">Poster & details</p>
          <h2>{heroTitle}</h2>
          <p className="preview-subtitle">{heroSubtitle}</p>

          <div className="preview-meta">
            <span>{preview ? formatDuration(preview.duration) : 'Ready when you are'}</span>
            <span>{preview ? formatViews(preview.viewCount) : 'Paste a valid URL'}</span>
            <span>{format === 'mp3' ? `MP3 ${quality}` : `${quality === 'best' ? 'Best' : `${quality}p`} video`}</span>
          </div>

          {previewStatus === 'loading' && (
            <p className="preview-state">Fetching title, channel, and poster...</p>
          )}

          {previewStatus === 'error' && (
            <p className="preview-state preview-state-error">{previewError}</p>
          )}

          {preview && (
            <div className="preview-glass">
              <p className="preview-stat-label">Channel</p>
              <p className="preview-stat-value">{preview.uploader}</p>
              <p className="preview-stat-label">Duration</p>
              <p className="preview-stat-value">{formatDuration(preview.duration)}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
