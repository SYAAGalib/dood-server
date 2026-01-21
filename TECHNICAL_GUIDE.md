# DooD Serve — Technical Guide

## Overview

DooD Serve is a lightweight, self-hosted PaaS that runs as a single container and manages the host Docker engine (Docker-out-of-Docker). It serves a Web UI and manages projects, deployments, and central database containers.

Key components:

- Hono HTTP server (TypeScript)
- SQLite for configuration and state
- Docker control via dockerode
- HTMX + Tailwind for UI

## Architecture

- The app container mounts the host Docker socket.
- Projects are built as Docker images and run as containers.
- Project configuration and runtime state are stored in SQLite.
- Central databases (MongoDB/Postgres) are managed as Docker containers, each with its own named volume.

## Deployment Flow

1. Clone or pull repo via SSH key.
2. Ensure a Dockerfile (auto-generated if missing).
3. Build image.
4. Stop/remove old container.
5. Run new container with restart policy and port mapping.
6. Prune dangling images.

## Central Database System

You can create multiple central database containers:

- MongoDB + Mongo Express
- Postgres + PgAdmin

Each central DB:

- Has a unique container name
- Uses a named volume for persistent data
- Can start/stop DB and its UI independently

## Persistence

Persistent data lives on the VPS via the mounted volume:

- /app/data for SQLite
- Named Docker volumes for central DB containers
- /root/.ssh for the SSH key

As long as these volumes remain, docker down/up will not lose data.

## Database Schema

SQLite core tables:

- projects: managed app definitions
- settings: global settings
- ssh_keys: SSH key metadata
- users, sessions: auth
- central_dbs: multiple central DB definitions

## Backups

### Full Central DB Backup

- MongoDB: run mongodump inside the central MongoDB container and archive the output.
- Postgres: use pg_dump inside the central Postgres container.

### Single Website Database Backup

- If the website uses a shared central DB, backup by database name:
  - MongoDB: mongodump --db <db-name>
  - Postgres: pg_dump -d <db-name>

Store backups off-host in a git repo or an external storage system.

## Security Notes

- SSH private keys are stored with strict permissions inside the container.
- Optional dashboard Basic Auth is supported.
- First-time setup creates the initial admin.

## Operations

Host-level controls are available in the UI:

- Start/stop all app containers
- Prune Docker resources (images/containers/volumes/networks)
- Start/stop central DBs and their UIs

## Ports

Default UI: 8080
Default Mongo Express: 8081
Default PgAdmin: 5050

Adjust as needed in the UI per database instance.
