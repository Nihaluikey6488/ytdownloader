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

## Deploy globally

## Option 1: Single server or VPS

Use one Node server for both frontend and backend:

1. `npm install`
2. `npm run build`
3. install `ffmpeg`
4. `npm start`

This is the simplest way to deploy the full app globally.

## Option 2: Docker

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

## Notes

- This app is not a good fit for static-only hosting by itself because downloads are handled by the Express backend.
- It is also not ideal for most serverless-only platforms because the backend depends on `yt-dlp`, `ffmpeg`, and temporary file creation.
