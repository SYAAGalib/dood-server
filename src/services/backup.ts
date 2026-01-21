import cron from "node-cron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import type Docker from "dockerode";
import { cloneOrPull, runGit } from "./git.js";

const BACKUP_DIR = "/app/backups";
const BACKUP_BRANCH = "server database backup";

export function startBackupCron(db: Database.Database, docker: Docker) {
  cron.schedule("0 0 * * 0", async () => {
    try {
      await runBackup(db, docker);
    } catch (error) {
      console.error("Backup failed", error);
    }
  });
}

async function runBackup(db: Database.Database, docker: Docker) {
  await mkdir(BACKUP_DIR, { recursive: true });

  const projects = db
    .prepare(
      "SELECT id, repo_url, mongo_container FROM projects WHERE provision_db = 1 AND mongo_container IS NOT NULL"
    )
    .all() as Array<{ id: number; repo_url: string; mongo_container: string }>;

  if (projects.length === 0) {
    return;
  }

  for (const project of projects) {
    const repoPath = join(BACKUP_DIR, `repo-${project.id}`);
    await cloneOrPull(project.repo_url, repoPath);
    await runGit(["-C", repoPath, "config", "user.email", "dood@local"]).catch(() => null);
    await runGit(["-C", repoPath, "config", "user.name", "DooD Serve"]).catch(() => null);
    await runGit(["-C", repoPath, "fetch", "origin", BACKUP_BRANCH]).catch(() => null);
    await runGit([
      "-C",
      repoPath,
      "checkout",
      "-B",
      BACKUP_BRANCH,
      `origin/${BACKUP_BRANCH}`,
    ]).catch(async () => {
      await runGit(["-C", repoPath, "checkout", "-B", BACKUP_BRANCH]);
    });

    const containerName = project.mongo_container as string;
    const archiveName = `mongo-${project.id}-${new Date()
      .toISOString()
      .slice(0, 10)}.gz`;
    const archivePath = join(BACKUP_DIR, archiveName);

    const mongoContainer = docker.getContainer(containerName);
    const exec = await mongoContainer.exec({
      Cmd: [
        "mongodump",
        "--archive=/tmp/backup.gz",
        "--gzip",
      ],
      AttachStdout: true,
      AttachStderr: true,
    });

    await new Promise<void>((resolve, reject) => {
      exec.start({}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) {
          reject(err || new Error("mongodump stream missing"));
          return;
        }
        stream.on("end", resolve);
        stream.on("error", reject);
      });
    });

    const archiveStream = await mongoContainer.getArchive({
      path: "/tmp/backup.gz",
    });

    const chunks: Buffer[] = [];
    for await (const chunk of archiveStream) {
      chunks.push(chunk as Buffer);
    }

    const tarBuffer = Buffer.concat(chunks);
    const extracted = await extractTarSingle(tarBuffer);
    await writeFile(archivePath, extracted);

    await runCommand("zip", ["-j", join(repoPath, `${archiveName}.zip`), archivePath]);

    const date = new Date().toISOString().slice(0, 10);
    await runGit(["-C", repoPath, "add", "."]);
    await runGit([
      "-C",
      repoPath,
      "commit",
      "-m",
      `Weekly Backup: ${date}`,
    ]).catch(() => null);
    await runGit(["-C", repoPath, "push", "-u", "origin", BACKUP_BRANCH]);
  }
}

async function extractTarSingle(tarBuffer: Buffer) {
  const headerBlock = tarBuffer.subarray(0, 512);
  const sizeOctal = headerBlock.toString("utf8", 124, 136).replace(/\0/g, "").trim();
  const size = parseInt(sizeOctal || "0", 8);
  const fileStart = 512;
  const fileEnd = fileStart + size;
  return tarBuffer.subarray(fileStart, fileEnd);
}

async function runCommand(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} failed with code ${code}`));
      }
    });
  });
}
