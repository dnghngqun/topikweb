# TopikWebCodex

Full-stack TOPIK practice web app inspired by the screenshots in `ScreenShot/`.

## Run

```bash
docker compose up -d --build
```

Frontend: http://localhost:5173  
Backend API: http://localhost:4000/api  
Postgres host port: `5433` (`5432` inside Docker)

## Auth

Firebase Google/email login is wired in the frontend and backend. Add these values to `.env` and rebuild:

```bash
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_APP_ID=
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
```

If Firebase values are missing, Docker still runs with backend dev auth (`DEV_AUTH_ENABLED=true`).

## AI

`.env` already supports:

```bash
OPENROUTER_API_KEY=
OPENROUTER_MODEL=openrouter/free
```

The default model uses OpenRouter's free model router. Override `OPENROUTER_MODEL` if a specific `:free` model works better.

## TOPIK Data Crawler

From the UI, open `/admin` and submit a source URL.

CLI:

```bash
docker compose exec backend npm run crawl -- "https://example.com/topik-source" --ai
```

The crawler imports exam metadata and discovers PDF/audio/image links. It has a specialized parser for `dethitracnghiem.vn` that imports question HTML, images, per-question audio and choices.

Daily crawler:

```bash
CRAWLER_ENABLED=true
CRAWL_INTERVAL_HOURS=24
CRAWLER_TICK_MINUTES=60
CRAWL_SOURCES=https://dethitracnghiem.vn/bai-thi/de-thi-topik-1-de-1/,https://dethitracnghiem.vn/?s=topik
```

The backend creates `crawl_sources`, checks them on startup and then on schedule, discovers new TOPIK links, and imports due exam pages. If a source does not expose the correct answer in public HTML, the imported answer is marked `unknown` instead of inventing one.
