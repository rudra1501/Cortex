# Architecture Overview

## Monorepo Structure

The project uses a pnpm workspace to manage multiple applications within a single repository.

```
apps/
    web/
    api/
    worker/

packages/
docker/
docs/
```

Each application is developed independently while sharing a common workspace.

---

## Web Application

The web application is built with Next.js and serves as the primary user interface.

Responsibilities include:

* Authentication UI
* Dashboard
* Document management
* Chat interface
* Retrieval Playground (later milestones)

The web application communicates with the API over HTTP.

---

## API Process

The API is implemented using Fastify.

Responsibilities include:

* Authentication
* Document management
* Retrieval endpoints
* Chat endpoints
* Configuration
* Evaluation endpoints (future milestones)

At the current milestone, the API exposes health endpoints and serves as the primary backend entry point.

---

## Worker Process

The Worker is a separate Fastify process responsible for background tasks.

Future responsibilities include:

* Document parsing
* Chunk generation
* Embedding creation
* Ingestion pipeline execution

The Worker is intentionally separated from the API to allow independent scaling and background processing.

---

## PostgreSQL

PostgreSQL is the primary database.

It will store:

* Users
* Documents
* Chunks
* Embeddings (pgvector)
* Chat sessions
* Retrieval configuration
* Evaluation data

The project intentionally uses a single PostgreSQL database instead of introducing multiple databases.

---

## Redis

Redis is introduced from the beginning to support asynchronous processing.

In future milestones it will be used by BullMQ to queue ingestion jobs and coordinate communication between the API and Worker.

---

## Current Communication

At the M0 milestone:

* The Web application runs independently.
* The API runs independently.
* The Worker runs independently.
* PostgreSQL and Redis are available through Docker Compose.

No runtime communication exists between these services yet.

---

## Future Communication

The planned interaction between services is:

```
Web
 │
 ▼
API
 │
 ├── PostgreSQL
 │
 └── Redis Queue
         │
         ▼
      Worker
         │
         ▼
   PostgreSQL
```

The API will enqueue background jobs into Redis.

The Worker will consume those jobs, process documents, generate embeddings, and persist results into PostgreSQL.

This separation keeps request handling and background processing independent while allowing each process to scale according to workload.
