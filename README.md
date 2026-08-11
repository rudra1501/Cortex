# Cortex

Cortex is a Retrieval Engineering project focused on building a production-quality document retrieval pipeline rather than just a chatbot. The project emphasizes understanding and improving every stage of retrieval, including document ingestion, chunking, embeddings, vector search, hybrid retrieval, context engineering, and evaluation.

The project is being developed incrementally through milestones, with each milestone introducing new capabilities while maintaining a clean and scalable architecture.

---

## Tech Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS
- **API:** Fastify
- **Worker:** Fastify
- **Database:** PostgreSQL + pgvector
- **ORM:** Prisma
- **Authentication:** JWT + bcrypt
- **Validation:** Zod
- **Queue:** Redis + BullMQ
- **Embeddings:** Google Gemini
- **Package Manager:** pnpm
- **Containerization:** Docker & Docker Compose

---

## Prerequisites

Before running the project, install:

- Node.js 22 LTS
- pnpm
- Docker Desktop (or Docker Engine + Docker Compose)
- Git

Verify your installation:

```bash
node -v
pnpm -v
docker --version
docker compose version
git --version
```

---

## Installation

Clone the repository:

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd Cortex
```

Install workspace dependencies:

```bash
pnpm install
```

---

## Environment Variables

### API

Create an `.env` file inside `apps/api`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cortex"
JWT_SECRET="your-secret-key"
REDIS_HOST="localhost"
REDIS_PORT="6379"
UPLOAD_DIR="uploads"
```

### Worker

Create an `.env` file inside `apps/worker`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cortex"
REDIS_HOST="localhost"
REDIS_PORT="6379"
GEMINI_API_KEY="your-gemini-api-key"
```

> Never commit `.env` files or API keys to the repository.

---

## Database Setup

Start PostgreSQL and Redis:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Run database migrations:

```bash
pnpm --filter api prisma migrate dev
```

Generate Prisma Client:

```bash
pnpm --filter api prisma generate
```

The PostgreSQL database uses **pgvector** for storing document chunk embeddings.

---

## Run Applications

### Web

```bash
pnpm --filter web dev
```

Runs on:

```text
http://localhost:3000
```

---

### API

```bash
pnpm --filter api dev
```

Runs on:

```text
http://localhost:3001
```

Health endpoint:

```http
GET /health
```

---

### Worker

```bash
pnpm --filter worker dev
```

Runs on:

```text
http://localhost:3002
```

Health endpoint:

```http
GET /health
```

The Worker processes document ingestion jobs asynchronously through BullMQ and Redis.

---

## Project Structure

```text
Cortex
├── apps
│   ├── web
│   ├── api
│   └── worker
├── docker
├── docs
└── packages
```

---

## Current Features

### Authentication

- User Registration
- User Login
- JWT Access Token Authentication
- Refresh Token Flow
- Protected Routes
- Password Hashing with bcrypt

### Document Management

- Create documents through file upload
- List user documents
- Get document by ID
- Update document metadata
- Delete documents
- User-owned document isolation
- Uploaded file cleanup

### Document Ingestion

- PDF uploads
- Markdown uploads
- Local file storage
- Asynchronous ingestion using BullMQ
- Redis-backed job queue
- Dedicated Worker processing
- PDF text extraction
- Markdown text extraction
- Raw text storage
- Fixed-size chunking
- Configurable chunk overlap
- Chunk metadata storage
- Google Gemini embeddings
- 3072-dimensional embeddings
- pgvector storage
- Ingestion status tracking
- Processing failure handling

### Ingestion Status

Documents move through the following lifecycle:

```text
PENDING
   │
   ▼
PROCESSING
   │
   ├──────────────► READY
   │
   └──────────────► FAILED
```

---

## Document Ingestion Flow

```text
Upload Document
       │
       ▼
Store Uploaded File
       │
       ▼
Create Document
       │
       ▼
Queue Ingestion Job
       │
       ▼
Redis / BullMQ
       │
       ▼
Worker
       │
       ▼
Parse Document
       │
       ▼
Extract Raw Text
       │
       ▼
Store rawText
       │
       ▼
Fixed-size Chunking
       │
       ▼
Store Chunks
       │
       ▼
Generate Embeddings
       │
       ▼
Store Vectors in pgvector
       │
       ▼
Status → READY
```

The API is responsible for accepting uploads, storing metadata and files, and creating ingestion jobs.

The Worker is responsible for the complete asynchronous ingestion pipeline.

---

## Architecture

The API follows a modular, layered architecture:

```text
modules/
├── auth/
│   ├── application/
│   ├── infrastructure/
│   └── presentation/
│
└── documents/
    ├── application/
    ├── infrastructure/
    └── presentation/
```

Each module is divided into:

- **Presentation** – Routes, controllers and request validation.
- **Application** – Business logic and use cases.
- **Infrastructure** – Database repositories, file storage, queues and external services.

The Worker separates document processing from the API:

```text
                    ┌─────────────┐
                    │     API     │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   BullMQ    │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │    Redis    │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │   Worker    │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           Parsing      Chunking    Embeddings
              │            │            │
              └────────────┴────────────┘
                           │
                           ▼
                    PostgreSQL
                     + pgvector
```

---

## Current Milestone

### ✅ M0 — Project Scaffold

Completed:

- pnpm Workspace
- Next.js Application
- Fastify API
- Fastify Worker
- Docker Compose
- PostgreSQL + pgvector
- Redis
- Development Environment Setup

---

### ✅ M1 — Authentication & Document Metadata

Completed:

- JWT Authentication
- Refresh Token Flow
- Password Hashing with bcrypt
- Request Validation with Zod
- Protected API Routes
- User Registration & Login
- Document Metadata CRUD
- User Authorization & Ownership Checks

---

### ✅ M2 — Document Ingestion Pipeline

Completed:

- PDF and Markdown uploads
- Multipart file handling
- Local file storage
- Document metadata persistence
- BullMQ ingestion queue
- Redis-backed asynchronous processing
- Dedicated Worker
- PDF parsing
- Markdown parsing
- Raw text extraction
- Document status lifecycle
- Fixed-size chunking
- Configurable chunk overlap
- Chunk persistence
- Google Gemini embedding generation
- 3072-dimensional embeddings
- pgvector embedding storage
- Ingestion failure handling
- Uploaded file cleanup
- Document status endpoint


---

## Roadmap

```text
M0 — Project Scaffold
        │
        ▼
M1 — Authentication & Document Metadata
        │
        ▼
M2 — Document Ingestion Pipeline
        │
        ▼
M3 — Retrieval Pipeline
        │
        ▼
M4 — Hybrid Retrieval & Context Engineering
        │
        ▼
M5 — Evaluation & Retrieval Quality
```

---

## Next Milestone

### 🚧 M3 — Retrieval Pipeline

Planned:

- Query Embeddings
- Vector Search
- Retrieval Module
- Context Builder
- Prompt Builder
- Streaming Chat
- Source Citations

Vector search and retrieval are intentionally not implemented in M2. M2 focuses on preparing searchable document data for future retrieval.

---

## Development Philosophy

Cortex is intentionally developed milestone by milestone.

Each milestone focuses on understanding and implementing one part of the retrieval system rather than hiding complexity behind high-level abstractions.

The goal is to understand the complete pipeline:

```text
Documents
    ↓
Ingestion
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
Context Engineering
    ↓
Generation
    ↓
Evaluation
```