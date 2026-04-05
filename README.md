# minsnote-api

Backend API for [minsnote](https://jinwonmin.github.io) blog. Built with Cloudflare Workers + KV + D1.

## Features

**Core**
- Post view counter (IP-based daily dedup)
- Like toggle (IP-based)
- Visitor counter (today / total)
- Comments with 4-digit password, threaded replies (1-level)

**Security**
- API key authentication (X-API-Key header)
- CORS origin whitelist
- Comment rate limiting (60s cooldown)
- Reserved nickname blocking (admin token bypass)
- Password hashing (SHA-256 with salt)

## API

All requests require `X-API-Key` header.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/post-stats` | Track view + get likes/liked status |
| POST | `/api/views` | Increment view count |
| GET | `/api/views?slug=xxx` | Get view count |
| POST | `/api/likes` | Toggle like |
| GET | `/api/likes?slug=xxx` | Get like count + liked status |
| POST | `/api/visitors` | Track visitor |
| GET | `/api/visitors` | Get today/total visitors |
| GET | `/api/comments?slug=xxx` | Get comments |
| POST | `/api/comments` | Create comment |
| PUT | `/api/comments` | Edit comment |
| DELETE | `/api/comments` | Delete comment |

## Tech Stack

| Category | Technology |
| --- | --- |
| Runtime | Cloudflare Workers |
| Language | TypeScript |
| Key-Value Store | Cloudflare KV (views, likes, visitors, rate limit) |
| Database | Cloudflare D1 / SQLite (comments) |
| Frontend | [minsnote.github.io](https://github.com/JINWONMIN/minsnote.github.io) |

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
wrangler kv namespace create VIEWS
wrangler d1 create minsnote-db
```

### 3. Configure wrangler.toml

Copy the example and fill in the KV/D1 IDs:

```bash
cp wrangler.toml.example wrangler.toml
```

### 4. Create D1 tables

```bash
wrangler d1 execute minsnote-db --remote --file=schema/001_init.sql
wrangler d1 execute minsnote-db --remote --file=schema/002_add_password.sql
```

### 5. Set secrets

```bash
echo "your_api_key" | wrangler secret put API_KEY
wrangler secret put ADMIN_TOKEN
```

### 6. Deploy

```bash
wrangler deploy
```

## Project Structure

```
├── src/
│   └── index.ts          # Worker entry point (all routes)
├── schema/               # D1 migration files
├── wrangler.toml.example # Wrangler config template
└── package.json
```
