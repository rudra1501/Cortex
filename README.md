# Cortex

Cortex is a Retrieval Engineering project that focuses on building a production-quality document retrieval pipeline.

The project explores the core components of modern RAG systems, including document ingestion, chunking, embeddings, vector search, retrieval configuration, context construction, and response generation.

Instead of relying on high-level frameworks, each component is implemented incrementally to understand how retrieval systems work internally.

```text
Documents
    ↓
Parsing
    ↓
Chunking
    ↓
Embeddings
    ↓
Vector Storage
    ↓
Retrieval
    ↓
Generation
```

---

## Tech Stack

- TypeScript
- Fastify
- PostgreSQL
- pgvector
- Prisma
- Redis
- BullMQ
- Google Gemini
- Docker
- Next.js

---

## Implemented Features

### Authentication

- User registration and login
- JWT authentication
- Refresh tokens
- Protected routes

### Document Ingestion

- PDF and Markdown uploads
- Local file storage
- Background processing with BullMQ
- Text extraction
- Configurable chunking
- Embedding generation
- Vector storage with pgvector
- Document status tracking
- Document reprocessing(if the chunking strategy is changed)

### Retrieval

- Query embeddings
- Configurable vector search
- Configurable Top-K
- Configurable similarity threshold
- Retrieval strategy abstraction
- Context construction
- Prompt building

### Chat

- Chat sessions
- Persistent chat messages
- Server-Sent Events (SSE) streaming
- Source citations

---

## Project Structure

```text
Cortex
├── apps
│   ├── api
│   ├── web
│   └── worker
├── docker
└── packages
```

---

## Getting Started

### Install dependencies

```bash
pnpm install
```

### Start PostgreSQL and Redis

```bash
docker compose -f docker/docker-compose.yml up -d
```

### Run database migrations

```bash
pnpm --filter api prisma migrate dev
```

### Run the applications

```bash
pnpm --filter web dev
pnpm --filter api dev
pnpm --filter worker dev
```

---

## Environment Variables

### `apps/api/.env`

```env
DATABASE_URL=
JWT_SECRET=
REDIS_HOST=
REDIS_PORT=
UPLOAD_DIR=
GEMINI_API_KEY=
```

### `apps/worker/.env`

```env
DATABASE_URL=
REDIS_HOST=
REDIS_PORT=
GEMINI_API_KEY=
```

---

## Project Milestones

```text
✅ M0 — Project Scaffold

✅ M1 — Authentication & Document Management

✅ M2 — Document Ingestion Pipeline

✅ M3 — Retrieval Pipeline

✅ M4 — Configurable Retrieval & Context Engineering

🚧 M5 — Hybrid Retrieval & Reranking
```