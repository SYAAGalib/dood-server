# DooD Serve — Development Guide

## Local Development

1. Install Docker.
2. Build and run:
   - docker compose up --build
3. Open UI: http://localhost:8080

## Project Requirements

- App must expose a port and respond on it.
- If no Dockerfile is present, DooD Serve generates a Node.js Dockerfile.

## Creating a Website Project

1. Ensure the repo has:
   - package.json
   - start script
2. Add project in the UI:
   - Repo URL
   - Domain
   - Port
3. Deploy.

## Connecting to a Central Database

### MongoDB

- Use the central MongoDB container name as host.
- Example connection string:
  mongodb://<central-mongo-container>:27017/<db-name>

### Postgres

- Use the central Postgres container name as host.
- Example connection string:
  postgresql://<user>:<pass>@<central-postgres-container>:5432/<db-name>

## Multi‑Website, Single Central DB

Recommended pattern:

- One database per website in the same DB server.
- MongoDB: one database name per project
- Postgres: one database name per project

Example naming:

- app_foo
- app_bar

## Central DB Provisioning

Use the Central Database section to create a DB container:

- Choose MongoDB or Postgres
- Set container name and ports
- For Postgres, set DB user, password, and database name
- For UI tools, set UI port and credentials

## Admin UIs

- Mongo Express for MongoDB
- PgAdmin for Postgres

Start or stop these UIs in the Central Database list.

## Backup Strategy

### Full DB Backup

- MongoDB:
  mongodump --archive=/tmp/backup.gz --gzip
- Postgres:
  pg_dump -U <user> -d <db-name> > /tmp/backup.sql

### Single Project Backup

- MongoDB:
  mongodump --db <db-name>
- Postgres:
  pg_dump -U <user> -d <db-name>

Store archives in:

- A git repo branch (recommended)
- Object storage (S3-compatible)

## Recommended Workflow

- Create central DB once.
- Use a dedicated DB name per website.
- Keep UI tools stopped unless needed.
- Add resource limits to project containers.

## Troubleshooting

- Check container status in the UI list.
- Verify ports are not already in use.
- Ensure the SSH key is saved and locked.

## Production Notes

- Keep /app/data and Docker volumes intact for persistence.
- Use Basic Auth if the server is publicly exposed.
