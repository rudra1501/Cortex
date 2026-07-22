# Cortex

Cortex is a Retrieval Engineering project focused on building a production-quality document retrieval pipeline rather than just a chatbot. The project emphasizes understanding and improving every stage of retrieval, including document ingestion, chunking, embeddings, vector search, hybrid retrieval, context engineering, and evaluation.

The project is being developed incrementally through milestones, with each milestone introducing new capabilities while maintaining a clean, scalable architecture.

---

## Tech Stack

- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS
- **API:** Fastify
- **Worker:** Fastify
- **Database:** PostgreSQL + pgvector
- **ORM:** Prisma
- **Authentication:** JWT + bcrypt
- **Validation:** Zod
- **Queue:** Redis (BullMQ in later milestones)
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

Create an `.env` file inside `apps/api`:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/cortex"
JWT_SECRET="your-secret-key"
```

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

---

## Run Applications

### Web

```bash
pnpm --filter web dev
```

Runs on:

```
http://localhost:3000
```

---

### API

```bash
pnpm --filter api dev
```

Runs on:

```
http://localhost:3001
```

Health endpoint:

```
GET /health
```

---

### Worker

```bash
pnpm --filter worker dev
```

Runs on:

```
http://localhost:3002
```

Health endpoint:

```
GET /health
```

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

### Document Metadata

- Create Document
- List Documents
- Get Document by ID
- Update Document
- Delete Document
- User-owned document isolation

---

## Architecture

The API follows a modular, layered architecture:

```text
modules/
└── auth/
    ├── application/
    ├── infrastructure/
    └── presentation/

└── documents/
    ├── application/
    ├── infrastructure/
    └── presentation/
```

Each module is divided into:

- **Presentation** – Routes, controllers and request validation.
- **Application** – Business logic (use cases).
- **Infrastructure** – Database repositories and external services.

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

## Next Milestone

### 🚧 M2 — Document Ingestion

Planned:

- File Uploads
- Document Storage
- Background Processing
- Queue Integration (BullMQ)
- Processing Status Updates