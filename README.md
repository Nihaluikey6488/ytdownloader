# YouTube Downloader

A full-stack YouTube downloader built with React, Vite, Express, `yt-dlp`, and `ffmpeg`.

## Features

- MP4 video downloads with quality selection
- MP3 audio downloads with bitrate selection
- Live poster / thumbnail preview
- Single-server production mode: Express serves the built React app from `dist/`
- Optional split deployment: frontend can target a separate backend with `VITE_API_BASE_URL`

## Local development

Install dependencies:

```powershell
npm install
```

Run the frontend:

```powershell
npm run dev
```

Run the backend:

```powershell
npm run server
```

## Production build

Build the frontend:

```powershell
npm run build
```

Start the production server:

```powershell
npm start
```

The Express server will serve:

- the API under `/api/*`
- the built frontend from `dist/`

## Environment variables

See [.env.example](./.env.example) for the full list.

Important ones:

- `PORT`: backend port, defaults to `3001`
- `FRONTEND_URL`: used in health output and local defaults
- `CORS_ORIGIN`: optional comma-separated allowlist for cross-origin frontend deployments
- `VITE_API_BASE_URL`: optional frontend API base URL when the frontend and backend are deployed separately
- `FFMPEG_PATH`: optional explicit path to `ffmpeg`
- `YT_DLP_PATH`: optional explicit path to a system `yt-dlp` binary

## Deploy globally

## Option 1: Single server or VPS

Use one Node server for both frontend and backend:

1. `npm install`
2. `npm run build`
3. install `ffmpeg`
4. `npm start`

This is the simplest way to deploy the full app globally.

## Option 2: Docker

The included Docker image is the recommended path for Render. It installs
system `yt-dlp` and `ffmpeg`, then starts the single Express server that serves
both the frontend and the API.

Build the image:

```bash
docker build -t youtube-downloader .
```

Run the container:

```bash
docker run -p 3001:3001 youtube-downloader
```

Then open:

- `http://your-server:3001`

## Option 3: Split frontend and backend

If you deploy the frontend and backend separately:

- deploy the backend as a normal Node service
- set `CORS_ORIGIN` on the backend
- set `VITE_API_BASE_URL` on the frontend before building

## Recommended deploy: Render + Cloudflare Pages

### Backend on Render

This repo now includes [render.yaml](./render.yaml) for the backend.

1. Push the repo to GitHub.
2. In Render, create a new Blueprint or Web Service from the repo.
3. Let Render use the included `render.yaml` and `Dockerfile`.
4. Set these env vars in Render:
   - `FRONTEND_URL=https://YOUR-CLOUDFLARE-PAGES-SITE.pages.dev`
   - `CORS_ORIGIN=https://YOUR-CLOUDFLARE-PAGES-SITE.pages.dev`

After deploy, test:

- `https://YOUR-RENDER-SERVICE.onrender.com/api/health`

It must return JSON.

### Frontend on Cloudflare Pages

Use Cloudflare Pages for the React frontend only.

Build settings:

- build command: `npm run build`
- build output directory: `dist`

Cloudflare Pages environment variable:

- `VITE_API_BASE_URL=https://YOUR-RENDER-SERVICE.onrender.com`

Then redeploy the Pages site.

### Final wiring check

Once both are deployed:

- open the Cloudflare Pages URL
- paste a YouTube URL
- confirm `/api/info` and `/api/download` are going to `onrender.com`, not `pages.dev`

## Notes

- This app is not a good fit for static-only hosting by itself because downloads are handled by the Express backend.
- It is also not ideal for most serverless-only platforms because the backend depends on `yt-dlp`, `ffmpeg`, and temporary file creation.
