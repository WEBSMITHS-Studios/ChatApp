# WEBSMITHS ChatApp

A small production-ready MVP for guest or account-backed nickname chat. It uses Next.js, TypeScript, Socket.IO, Prisma, SQLite, Tailwind CSS, and a custom Node server so realtime traffic works cleanly behind Cloudflare Tunnel.

## Features

- WEBSMITHS Global Chat at `/`
- Private 1-to-1 rooms with shareable links
- Group rooms with a max user count or unlimited capacity
- Nickname-only guest joining
- Optional account sign up and sign in
- Site admins through `ADMIN_EMAILS`
- Live messages over Socket.IO
- Online member count per room
- Optional room expiry
- Room roles: guest, admin, super_admin
- Room creator becomes super_admin
- Super_admin can promote admins, demote admins, and transfer ownership
- Admins and super_admin can delete messages
- Room ownership recovery code shown once when a room is created
- Safe local-disk attachments for images, GIFs, PDFs, and small videos
- Basic in-memory rate limiting for messages, room creation, sign in, and sign up
- PM2 support for Ubuntu Server

## Local Setup

```bash
npm install
cp .env.example .env
npm run db:push
npm run dev
```

Open `http://localhost:3000`.

## Production Build

```bash
npm install
cp .env.example .env
npm run db:push
npm run build
npm run start
```

For production, set `DATABASE_URL="file:./prod.db"` in `.env` or in your process environment.
Set `UPLOAD_DIR` to a writable folder for uploaded files. Keep it outside your source checkout if you prefer, for example `/var/lib/websmiths-chat/uploads`.

Set `ADMIN_EMAILS` to a comma-separated list of account emails that should be admins in WEBSMITHS Global Chat:

```bash
ADMIN_EMAILS="owner@example.com,moderator@example.com"
```

## Ubuntu + PM2

```bash
sudo apt update
sudo apt install -y nodejs npm
sudo npm install -g pm2

npm install
cp .env.example .env
npm run db:push
npm run build
mkdir -p logs
mkdir -p uploads
npm run pm2:start
pm2 save
pm2 startup
```

The included `ecosystem.config.cjs` runs one Node process. SQLite is best kept to a single app process unless you later move to Postgres.

## Cloudflare Tunnel

Point your tunnel at the local app:

```bash
cloudflared tunnel route dns <tunnel-name> chat.example.com
cloudflared tunnel run <tunnel-name>
```

Example tunnel config:

```yaml
tunnel: <tunnel-id>
credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: chat.example.com
    service: http://localhost:3000
  - service: http_status:404
```

Set `NEXT_PUBLIC_APP_URL="https://chat.example.com"` in production so Socket.IO CORS matches your public hostname.

## Notes

- Prisma SQLite does not support enums, so room role/type and attachment kind are stored as strings and enforced in TypeScript.
- Guest identities are stored in the browser. Account identities are backed by secure HTTP-only session cookies.
- Passwords are hashed with Node's built-in `scrypt`.
- Room recovery codes are shown once on creation and stored only as hashes.
- Socket moderation uses server-verified room membership, not client-sent identities.
- Uploads are served through API routes, validated by MIME and extension, and stored with randomized filenames.
- Allowed uploads are JPEG, PNG, WebP, GIF, PDF, MP4, WebM, and MOV. SVG, HTML, JavaScript, executables, scripts, archives, and all other unlisted types are rejected.
- Anonymous uploads expire after 1 hour; logged-in uploads are pruned to stay under 500MB per account.
- Logged-in account files are removed after 30 days of account inactivity without deleting accounts, chats, rooms, memberships, or text messages.
- Site super admins can open `/admin` to view health, storage, account usage, cleanup, and safe update-check tools.
- Rate limiting is in-memory for simplicity. If you run more than one app process later, move limits to Redis.
- Deleted messages keep their database row but clear the body and show as deleted in the UI.
