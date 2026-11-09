# Summit Thread

Local development foundation for a conference reader built around released speech, topic threads, and private cited answers.

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

Open http://127.0.0.1:5185. The status page makes an actual readiness request through the Vite proxy to the backend. The foundation exposes liveness/readiness; room creation, uploads, transcription, topic processing, and private Ask are subsequent feature work.

```sh
npm run check
npm run services:down
```

See [development](docs/development.md), [architecture](docs/architecture.md), and [development tools](docs/development-tools.md). Never commit real environment files, credentials, conference media, participant content, or local service data. No AI-provider key is needed for the foundation. Local demo routes are not authenticated deployment boundaries.
