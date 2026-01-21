import { mkdir, writeFile, chmod, access, readFile, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SSH_DIR = "/root/.ssh";
const SSH_KEY_PATH = "/root/.ssh/id_rsa";
const SSH_KNOWN_HOSTS = "/root/.ssh/known_hosts";

export async function ensureSshKey(privateKey: string) {
  await mkdir(SSH_DIR, { recursive: true, mode: 0o700 });

  await writeFile(SSH_KEY_PATH, privateKey.trim() + "\n", { mode: 0o600 });
  await chmod(SSH_KEY_PATH, 0o600);
  await chmod(SSH_DIR, 0o700);

  // Pre-seed GitHub host key to avoid interactive prompt during clone/pull.
  // Strict permissions are required or OpenSSH will refuse to use the key.
  await ensureKnownHost("github.com");
}

export async function deleteSshKey() {
  try {
    await unlink(SSH_KEY_PATH);
  } catch {
    // ignore if missing
  }
}

export function getGitSshCommand() {
  return `ssh -i ${SSH_KEY_PATH} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}

export async function cloneOrPull(repoUrl: string, dest: string) {
  try {
    await access(join(dest, ".git"));
    await runGit(["-C", dest, "fetch", "--all", "--prune"]);
    await runGit(["-C", dest, "reset", "--hard", "origin/HEAD"]);
  } catch {
    await runGit(["clone", repoUrl, dest]);
  }
}

export async function gitStatusHash(repoUrl: string) {
  const hash = createHash("sha1").update(repoUrl).digest("hex");
  return hash.slice(0, 10);
}

export async function runGit(args: string[], cwd?: string) {
  const env = { ...process.env, GIT_SSH_COMMAND: getGitSshCommand() };

  return new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

export async function testGithubSsh() {
  await access(SSH_KEY_PATH);
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    const child = spawn("ssh", ["-T", "git@github.com"], {
      env: { ...process.env, GIT_SSH_COMMAND: getGitSshCommand() },
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("exit", (code) => {
      resolve({ ok: code === 1 || code === 0, output: output.trim() });
    });
    child.on("error", () => {
      resolve({ ok: false, output: "SSH test failed" });
    });
  });
}

async function ensureKnownHost(host: string) {
  let existing = "";
  try {
    existing = await readFile(SSH_KNOWN_HOSTS, "utf8");
  } catch {
    existing = "";
  }

  if (existing.includes(host)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh-keyscan", ["-t", "rsa,ecdsa,ed25519", host], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(
          writeFile(SSH_KNOWN_HOSTS, existing + output, {
            mode: 0o644,
          }).then(() => chmod(SSH_KNOWN_HOSTS, 0o644))
        );
      } else {
        reject(new Error("ssh-keyscan failed"));
      }
    });
  });
}
