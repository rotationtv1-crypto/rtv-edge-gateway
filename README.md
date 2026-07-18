# RTV Edge Gateway ⚡

> **Production Cloudflare Worker — Streaming, Gifts, Auth**
> RotationTV Network LLC | Darrel-Spell-Living-Trust

## 🔧 503 Fix Applied (v3.0.0)

The 503 errors were caused by missing `SUPABASE_SERVICE_KEY` binding in the Cloudflare Worker environment. v3.0.0 adds:

1. **Environment validation** — graceful degradation instead of hard crash
2. **Health endpoint** reports missing bindings explicitly
3. **Structured error responses** tell you exactly what's wrong

### Fix Commands:
```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_ANON_KEY
npx wrangler secret put SUPABASE_SERVICE_KEY  # <-- This was missing
npx wrangler secret put CF_STREAM_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put WEBHOOK_SECRET
```

## 🚀 Deploy

```bash
npm install
npx wrangler deploy
```

## 📡 Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | None | Health check |
| POST | `/api/stream/create` | Bearer | Create live stream |
| POST | `/api/stream/:id/end` | Bearer | End stream |
| GET | `/api/stream/:id/play` | None | Get WHEP URL |
| GET | `/api/streams` | None | List live streams |
| POST | `/api/gift/send` | Bearer | Send gift to streamer |
| POST | `/webhook/stream` | Signature | CF Stream webhook |

## 🔐 Security

- Supabase JWT verification on all authenticated routes
- HMAC-SHA256 webhook signatures
- KV-backed rate limiting (20 gifts/min)
- Category 1 credential isolation

---
*Sovereign-grade. 432Hz resonance. Zero 503s.* 💎
