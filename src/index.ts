import { Hono } from "hono";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import Docker from "dockerode";
import { mkdir } from "node:fs/promises";
import { createProjectsRoutes } from "./routes/projects.js";
import { startBackupCron } from "./services/backup.js";

const app = new Hono();
const dbPath = "/app/data/dood.db";

await mkdir("/app/data", { recursive: true });

const db = new Database(dbPath);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

initDb(db);
startBackupCron(db, docker);

app.route("/", createProjectsRoutes(db, docker));

const port = Number(process.env.PORT || 1111);

serve({ fetch: app.fetch, port });
console.log(`DooD Serve running on :${port}`);

function initDb(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_url TEXT NOT NULL,
      repo_url_norm TEXT NOT NULL,
      domain TEXT NOT NULL,
      port INTEGER NOT NULL,
      provision_db INTEGER NOT NULL DEFAULT 0,
      mongo_container TEXT,
      container_name TEXT,
      image_tag TEXT,
      status TEXT DEFAULT 'stopped',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ssh_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS central_dbs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT,
      password TEXT,
      database_name TEXT,
      ui_port INTEGER,
      ui_username TEXT,
      ui_password TEXT,
      ui_container TEXT,
      volume_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deploy_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      log TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_projects_repo ON projects (repo_url_norm);
    CREATE INDEX IF NOT EXISTS idx_deploy_logs_project ON deploy_logs (project_id);
  `);

  try {
    database.exec(`
      INSERT INTO central_dbs (type, name, port, username, password, database_name, ui_port, ui_username, ui_password, ui_container, volume_name)
      SELECT type, name, port, username, password, database_name, ui_port, ui_username, ui_password, ui_container, volume_name
      FROM central_db
      WHERE (SELECT COUNT(*) FROM central_dbs) = 0
    `);
  } catch {
    // ignore legacy table missing
  }
}
