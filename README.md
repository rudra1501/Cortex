# Cortex

Cortex is a Retrieval Engineering project focused on building a production-quality document retrieval pipeline rather than just a chatbot. The project emphasizes understanding and improving every stage of retrieval, including document ingestion, chunking, embeddings, vector search, hybrid retrieval, context engineering, and evaluation.

The project is being developed incrementally through milestones, with each milestone introducing new capabilities while maintaining a clean, scalable architecture.

---

## Tech Stack

* **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS
* **API:** Fastify
* **Worker:** Fastify
* **Database:** PostgreSQL + pgvector
* **Queue:** Redis (BullMQ in later milestones)
* **Package Manager:** pnpm
* **Containerization:** Docker & Docker Compose

---

## Prerequisites

Before running the project, install:

* Node.js 22 LTS
* pnpm
* Docker Desktop (or Docker Engine + Docker Compose)
* Git

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

## Start Infrastructure

Start PostgreSQL and Redis:

```bash
docker compose -f docker/docker-compose.yml up -d
```

Verify containers:

```bash
docker ps
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

Health endpoint:

```
http://localhost:3001/health
```

---

### Worker

```bash
pnpm --filter worker dev
```

Health endpoint:

```
http://localhost:3002/health
```

---

## Project Structure

```
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

## Current Milestone

### ✅ M0 — Project Scaffold

Completed:

* pnpm workspace
* Next.js web application
* Fastify API
* Fastify Worker
* Docker Compose
* PostgreSQL + pgvector
* Redis
* Development environment setup

Next milestone:

**M1 — Authentication and Document Metadata**
