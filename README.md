# Summit Thread

**Summit Thread is a real-time conference companion that makes presentations more accessible and easier to follow.** It automatically organizes live presentations into a continuously updated feed of key topics and important moments. Whether you're arriving late, stepping away, or struggling to keep up, Summit Thread lets you instantly catch up on what you've missed, ask questions about the presentation, and explore explanations at your own pace. **So no matter when you join, you're never out of the loop.**

## Current implementation

Rooms, uploaded recording playback, shared presenter/attendee controls, and continuous finalized transcription are implemented on the local development foundation. Topic processing, visual analysis, search and private Ask remain subsequent feature work.

## Run locally

Requires Node 24, npm, Docker Compose v2, and available local ports 3110, 5185, 5435, and 9203.

```sh
npm ci
npm run install:all
cp backend/.env.example backend/.env
cp web/.env.example web/.env.local
npm run services:up
npm run db:push
npm run dev
```

Open http://127.0.0.1:5185 to join a room, or `/presenter` to create one, share its invitation, upload a recording and control attendee playback. `npm run dev` starts both the backend and frontend in one terminal; Docker services run in the background after `npm run services:up`.

The backend installs a pinned platform-specific `ffprobe` binary for source validation; no system FFmpeg installation is needed. Set the backend-only `GEMINI_API_KEY` for continuous transcription; media playback works without it. See [rooms and playback](docs/features/rooms-and-playback.md) for formats, contracts, recovery and verification status.

```sh
npm run check
npm run services:down
```

See [development](docs/development.md), [architecture](docs/architecture.md), and [development tools](docs/development-tools.md). Never commit real environment files, credentials, conference media, participant content, or local service data. No AI-provider key is needed for room creation, uploads or playback. Local demo routes are not authenticated deployment boundaries.
