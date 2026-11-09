# Summit Thread

**Summit Thread is a real-time conference companion that makes presentations more accessible and easier to follow.** It automatically organizes live presentations into a continuously updated feed of key topics and important moments. Whether you're arriving late, stepping away, or struggling to keep up, Summit Thread lets you instantly catch up on what you've missed, ask questions about the presentation, and explore explanations at your own pace. **So no matter when you join, you're never out of the loop.**

## Current implementation

The local app supports shared uploaded-recording playback, continuous finalized speech, evolving topic threads, catch-up navigation, elapsed-window original stills, and private Elasticsearch-backed answers with transcript citations. Camera intake is available through a presenter action with browser camera/microphone permission; attendee video uses a direct WebRTC connection. Streaming-platform intake remains visibly planned. Camera hardware verification is pending. PostgreSQL owns released state; Elasticsearch is rebuildable. Express owns backend contracts/providers and React uses generated API types.

## Run locally

Requires Node 24, npm, Docker Compose v2, FFmpeg/FFprobe on PATH for visual clips and stills, and available local ports 3110, 5185, 5435, and 9203.

```sh
npm ci
npm run install:all
cp backend/.env.example backend/.env
cp web/.env.example web/.env.local
npm run services:up
npm run db:deploy
npm run dev
```

Open http://127.0.0.1:5185 to join a room, or `/presenter` to create one, share its invitation, upload a recording and control attendee playback. `npm run dev` starts both the backend and frontend in one terminal; Docker services run in the background after `npm run services:up`.

The backend installs a pinned platform-specific `ffprobe` binary for source validation; source validation does not require a system install, but visual review requires FFmpeg and FFprobe on PATH. Set the backend-only `GEMINI_API_KEY` for continuous transcription; media playback works without it. See [rooms and playback](docs/features/rooms-and-playback.md) for formats, contracts, recovery and verification status.

```sh
npm run check
npm run services:down
```

See [development](docs/development.md), [architecture](docs/architecture.md), and [development tools](docs/development-tools.md). Never commit real environment files, credentials, conference media, participant content, or local service data. No AI-provider key is needed for room creation, uploads or playback. Local demo routes are not authenticated deployment boundaries.

## Walkthrough and development tools

Follow [the walkthrough](docs/walkthrough.md) for two-browser verification, recording guidance and recovery. Use a team-owned or consented source; keep recordings and participant content in ignored local storage. AI credentials enable transcription, topics, visual review and answers; playback does not require them.

Development used AI-assisted coding, Gitar review and Dash0 operational verification. Their observed results and limits are documented in [development tools](docs/development-tools.md); configuration alone is not proof of execution.

## Radar Cloud deployment

The `main` branch can be deployed to the team-owned Radar Cloud cluster through
Argo CD. See [Radar deployment](docs/radar-deployment.md) for the one-time
public-image, Argo application, runtime-secret, and verification steps. The
hosted hackathon route is `https://summitthread.cnh.radarhq.io`; it is not a
production authentication boundary.
