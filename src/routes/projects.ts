import { Hono } from "hono";
import Database from "better-sqlite3";
import Docker from "dockerode";
import { createHash, createHmac, timingSafeEqual, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, writeFile, access, readFile } from "node:fs/promises";
import { join } from "node:path";
import tar from "tar-fs";
import { layout } from "../ui/layout.js";
import { cloneOrPull, ensureSshKey, deleteSshKey, gitStatusHash, testGithubSsh } from "../services/git.js";

const REPOS_DIR = "/app/repos";
const DOCKERFILE_TEMPLATE = `FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
`;

export function createProjectsRoutes(db: Database.Database, docker: Docker) {
  const router = new Hono();

  router.use("*", async (c, next) => {
    const basicAuthEnabled = getSetting(db, "basic_auth_enabled") === "true";
    if (basicAuthEnabled) {
      const basicUser = getSetting(db, "basic_auth_user");
      const basicPass = getSetting(db, "basic_auth_pass");
      if (!checkBasicAuth(c.req.header("authorization") || "", basicUser, basicPass)) {
        c.header("WWW-Authenticate", "Basic");
        return c.text("Unauthorized", 401);
      }
    }

    const usersCount = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
    const hasUsers = usersCount.count > 0;
    const session = hasUsers ? await getSession(db, c.req.header("cookie") || "") : null;

    const path = c.req.path;
    const isPublic = path.startsWith("/login") || path.startsWith("/setup") || path.startsWith("/webhook");

    if (!hasUsers && !path.startsWith("/setup")) {
      return c.redirect("/setup");
    }

    if (hasUsers && !session && !isPublic) {
      return c.redirect("/login");
    }

    await next();
  });

  router.get("/", async (c) => {
    const existingKey = db.prepare("SELECT name FROM ssh_keys LIMIT 1").get() as
      | { name: string }
      | undefined;
    const centralDbFields = renderCentralDbFields("mongodb");
    const body = `
      <section class="grid gap-6 lg:grid-cols-3">
        <div class="lg:col-span-2 space-y-4">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-semibold">Projects</h2>
            <button
              class="rounded bg-slate-900 px-4 py-2 text-white"
              hx-get="/projects/partial"
              hx-target="#projects-table"
              hx-swap="outerHTML"
            >Refresh</button>
          </div>
          <div id="projects-table" hx-get="/projects/partial" hx-trigger="load"></div>
        </div>
        <div class="space-y-6">
          <div class="rounded border bg-white p-4 space-y-3">
            <h3 class="text-lg font-semibold">Central Database</h3>
            <p class="text-sm text-slate-600">Create and manage multiple shared databases (MongoDB or Postgres).</p>
            <form class="space-y-3" hx-post="/central-db" hx-target="#central-db-status" hx-swap="outerHTML">
              <label class="block text-sm">Database Type
                <select name="dbType" class="mt-1 w-full rounded border px-3 py-2" hx-get="/central-db/form" hx-target="#central-db-fields" hx-swap="innerHTML" hx-include="[name='dbType']">
                  <option value="mongodb">MongoDB</option>
                  <option value="postgres">Postgres</option>
                </select>
              </label>
              <div id="central-db-fields">${centralDbFields}</div>
              <button class="w-full rounded bg-emerald-600 px-4 py-2 text-white">Add Central DB</button>
              <div id="central-db-status" class="text-sm text-slate-600"></div>
            </form>
            <div id="central-db-list" hx-get="/central-db/partial" hx-trigger="load"></div>
          </div>
          <form
            class="rounded border bg-white p-4 space-y-3"
            hx-post="/settings/basic-auth"
            hx-target="#basic-auth-status"
            hx-swap="outerHTML"
          >
            <h3 class="text-lg font-semibold">Dashboard Basic Auth (Optional)</h3>
            <label class="flex items-center gap-2 text-sm">
              <input name="enabled" type="checkbox" class="rounded border" ${getSetting(db, "basic_auth_enabled") === "true" ? "checked" : ""} />
              Enable Basic Auth
            </label>
            <label class="block text-sm">Username
              <input name="username" class="mt-1 w-full rounded border px-3 py-2" value="${getSetting(db, "basic_auth_user")}" />
            </label>
            <label class="block text-sm">Password
              <input name="password" type="password" class="mt-1 w-full rounded border px-3 py-2" value="${getSetting(db, "basic_auth_pass")}" />
            </label>
            <button class="w-full rounded bg-slate-900 px-4 py-2 text-white">Save</button>
            <div id="basic-auth-status" class="text-sm text-slate-600"></div>
          </form>
          <div class="rounded border bg-white p-4 space-y-3">
            <h3 class="text-lg font-semibold">Host Controls</h3>
            <div class="grid gap-2">
              <button class="rounded bg-slate-900 px-4 py-2 text-white" hx-post="/ops/apps/start" hx-target="#ops-status" hx-swap="outerHTML">Docker Up (Start Apps)</button>
              <button class="rounded bg-amber-600 px-4 py-2 text-white" hx-post="/ops/apps/stop" hx-target="#ops-status" hx-swap="outerHTML">Docker Down (Stop Apps)</button>
              <button class="rounded bg-rose-600 px-4 py-2 text-white" hx-post="/ops/prune/all" hx-target="#ops-status" hx-swap="outerHTML">Prune All</button>
              <div class="grid grid-cols-2 gap-2">
                <button class="rounded bg-slate-700 px-3 py-2 text-white" hx-post="/ops/prune/images" hx-target="#ops-status" hx-swap="outerHTML">Prune Images</button>
                <button class="rounded bg-slate-700 px-3 py-2 text-white" hx-post="/ops/prune/containers" hx-target="#ops-status" hx-swap="outerHTML">Prune Containers</button>
                <button class="rounded bg-slate-700 px-3 py-2 text-white" hx-post="/ops/prune/volumes" hx-target="#ops-status" hx-swap="outerHTML">Prune Volumes</button>
                <button class="rounded bg-slate-700 px-3 py-2 text-white" hx-post="/ops/prune/networks" hx-target="#ops-status" hx-swap="outerHTML">Prune Networks</button>
              </div>
              <div id="ops-status" class="text-sm text-slate-600"></div>
            </div>
          </div>
          <form
            class="rounded border bg-white p-4 space-y-3"
            hx-post="/projects"
            hx-target="#projects-table"
            hx-swap="outerHTML"
          >
            <h3 class="text-lg font-semibold">Add Project</h3>
            <label class="block text-sm">GitHub Repo URL
              <input name="repoUrl" class="mt-1 w-full rounded border px-3 py-2" placeholder="git@github.com:user/repo.git" required />
            </label>
            <label class="block text-sm">Domain Name
              <input name="domain" class="mt-1 w-full rounded border px-3 py-2" placeholder="api.example.com" required />
            </label>
            <label class="block text-sm">Port
              <input name="port" type="number" class="mt-1 w-full rounded border px-3 py-2" placeholder="3000" required />
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input name="provisionDb" type="checkbox" class="rounded border" />
              Provision MongoDB
            </label>
            <button class="w-full rounded bg-emerald-600 px-4 py-2 text-white">Add & Deploy</button>
          </form>

          <form
            class="rounded border bg-white p-4 space-y-3"
            hx-post="/settings/ssh"
            hx-target="#ssh-status"
            hx-swap="outerHTML"
          >
            <h3 class="text-lg font-semibold">SSH Private Key</h3>
            ${existingKey ? `<div class=\"rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700\">Active key: ${existingKey.name}. This key is locked and can only be deleted.</div>` : ""}
            <label class="block text-sm">Key Name
              <input name="sshName" class="mt-1 w-full rounded border px-3 py-2" placeholder="GitHub Org" ${existingKey ? "disabled" : ""} />
            </label>
            <label class="block text-sm">Private Key
              <textarea name="sshKey" rows="6" class="mt-1 w-full rounded border px-3 py-2" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" ${existingKey ? "disabled" : ""}></textarea>
            </label>
            <div class="text-xs text-slate-500">Once saved, the key is locked and can only be deleted.</div>
            <div class="flex gap-2">
              <button class="flex-1 rounded bg-slate-900 px-4 py-2 text-white" ${existingKey ? "disabled" : ""}>Save</button>
              <button
                class="flex-1 rounded bg-rose-600 px-4 py-2 text-white"
                hx-delete="/settings/ssh"
                hx-target="#ssh-status"
                hx-swap="outerHTML"
                type="button"
              >Delete</button>
            </div>
            <button class="w-full rounded bg-slate-700 px-4 py-2 text-white" hx-post="/settings/ssh/test" hx-target="#ssh-status" hx-swap="outerHTML" type="button">Test SSH Key</button>
            <div id="ssh-status" class="text-sm text-slate-600"></div>
          </form>
        </div>
      </section>
    `;

    return c.html(layout("DooD Serve", body));
  });

  router.get("/setup", (c) => {
    const body = `
      <section class="max-w-lg space-y-4">
        <h2 class="text-xl font-semibold">First-time Setup</h2>
        <p class="text-sm text-slate-600">Create the first admin account to start using DooD Serve.</p>
        <form class="rounded border bg-white p-4 space-y-3" hx-post="/setup" hx-target="#setup-status" hx-swap="outerHTML">
          <label class="block text-sm">Username
            <input name="username" class="mt-1 w-full rounded border px-3 py-2" required />
          </label>
          <label class="block text-sm">Password
            <input name="password" type="password" class="mt-1 w-full rounded border px-3 py-2" required />
          </label>
          <button class="rounded bg-slate-900 px-4 py-2 text-white">Create Admin</button>
          <div id="setup-status" class="text-sm text-slate-600"></div>
        </form>
      </section>
    `;
    return c.html(layout("Setup", body));
  });

  router.post("/setup", async (c) => {
    const body = await c.req.parseBody();
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    if (!username || !password) {
      return c.html(`<div id="setup-status" class="text-sm text-rose-700">Username and password required.</div>`);
    }

    const existing = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: number } | undefined;
    if (existing) {
      return c.html(`<div id="setup-status" class="text-sm text-rose-700">Admin already exists. Please login.</div>`);
    }

    const { salt, hash } = hashPassword(password);
    const result = db.prepare("INSERT INTO users (username, salt, hash) VALUES (?, ?, ?)").run(username, salt, hash);
    const token = createSession(db, result.lastInsertRowid as number);
    setSessionCookie(c, token);
    return c.html(`<div id="setup-status" class="text-sm text-emerald-700">Admin created. Redirecting...</div><script>setTimeout(()=>location.href='/',700)</script>`);
  });

  router.get("/login", (c) => {
    const body = `
      <section class="max-w-lg space-y-4">
        <h2 class="text-xl font-semibold">Login</h2>
        <form class="rounded border bg-white p-4 space-y-3" hx-post="/login" hx-target="#login-status" hx-swap="outerHTML">
          <label class="block text-sm">Username
            <input name="username" class="mt-1 w-full rounded border px-3 py-2" required />
          </label>
          <label class="block text-sm">Password
            <input name="password" type="password" class="mt-1 w-full rounded border px-3 py-2" required />
          </label>
          <button class="rounded bg-slate-900 px-4 py-2 text-white">Login</button>
          <div id="login-status" class="text-sm text-slate-600"></div>
        </form>
      </section>
    `;
    return c.html(layout("Login", body));
  });

  router.post("/login", async (c) => {
    const body = await c.req.parseBody();
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    const row = db.prepare("SELECT id, salt, hash FROM users WHERE username = ?").get(username) as
      | { id: number; salt: string; hash: string }
      | undefined;
    if (!row || !verifyPassword(password, row.salt, row.hash)) {
      return c.html(`<div id="login-status" class="text-sm text-rose-700">Invalid credentials.</div>`);
    }
    const token = createSession(db, row.id);
    setSessionCookie(c, token);
    return c.html(`<div id="login-status" class="text-sm text-emerald-700">Logged in. Redirecting...</div><script>setTimeout(()=>location.href='/',700)</script>`);
  });

  router.post("/logout", (c) => {
    clearSessionCookie(c);
    return c.html(`<div class="text-sm text-emerald-700">Logged out.</div><script>setTimeout(()=>location.href='/login',500)</script>`);
  });

  router.get("/projects/partial", (c) => {
    const projects = db.prepare("SELECT * FROM projects ORDER BY id DESC").all();
    const rows = projects
      .map(
        (project: any) => `
        <tr class="border-b">
          <td class="px-4 py-3 font-medium">${project.repo_url}</td>
          <td class="px-4 py-3">${project.status || "stopped"}</td>
          <td class="px-4 py-3">${project.port}</td>
          <td class="px-4 py-3">${project.domain}</td>
          <td class="px-4 py-3">
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded bg-slate-900 px-3 py-1 text-white"
                hx-post="/projects/${project.id}/deploy"
                hx-target="#projects-table"
                hx-swap="outerHTML"
              >Deploy</button>
              <button
                class="rounded bg-amber-600 px-3 py-1 text-white"
                hx-post="/projects/${project.id}/stop"
                hx-target="#projects-table"
                hx-swap="outerHTML"
              >Stop</button>
              <button
                class="rounded bg-rose-600 px-3 py-1 text-white"
                hx-post="/projects/${project.id}/delete"
                hx-target="#projects-table"
                hx-swap="outerHTML"
              >Delete</button>
              <button
                class="rounded bg-slate-700 px-3 py-1 text-white"
                hx-get="/projects/${project.id}/logs"
                hx-target="#deploy-log"
                hx-swap="innerHTML"
              >Logs</button>
            </div>
          </td>
        </tr>
      `
      )
      .join("");

    return c.html(`
      <div class="overflow-x-auto rounded border bg-white">
        <table class="w-full text-sm">
          <thead class="bg-slate-100 text-left">
            <tr>
              <th class="px-4 py-3">Repository</th>
              <th class="px-4 py-3">Status</th>
              <th class="px-4 py-3">Port</th>
              <th class="px-4 py-3">Domain</th>
              <th class="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rows || "<tr><td class=\"px-4 py-3\" colspan=\"5\">No projects yet.</td></tr>"}
          </tbody>
        </table>
      </div>
      <div id="deploy-log" class="mt-3 rounded border bg-white p-3 text-xs text-slate-700">Select a project to view deploy logs.</div>
    `);
  });

  router.get("/projects", (c) => {
    const projects = db.prepare("SELECT * FROM projects ORDER BY id DESC").all();
    return c.json(projects);
  });

  router.post("/projects", async (c) => {
    const body = await c.req.parseBody();
    const repoUrl = String(body.repoUrl || "").trim();
    const domain = String(body.domain || "").trim();
    const port = Number(body.port || 0);
    const provisionDb = body.provisionDb === "on";

    if (!repoUrl || !domain || !port) {
      return c.text("Missing fields", 400);
    }

    const normalizedRepo = normalizeRepoUrl(repoUrl);
    const containerName = `dood-app-${await gitStatusHash(repoUrl)}`;
    const imageTag = `${containerName}:latest`;
    const mongoContainer = provisionDb ? `${containerName}-mongo` : null;

    db.prepare(
      `INSERT INTO projects (repo_url, repo_url_norm, domain, port, provision_db, mongo_container, container_name, image_tag, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped')`
    ).run(repoUrl, normalizedRepo, domain, port, provisionDb ? 1 : 0, mongoContainer, containerName, imageTag);

    if (provisionDb && mongoContainer) {
      await ensureMongoContainer(docker, mongoContainer);
    }

    await upsertCaddyBlock(domain, port);
    await reloadCaddy(docker);

    setImmediate(() => deployProject(db, docker, normalizedRepo));

    return c.html(await projectsTable(db));
  });

  router.post("/projects/:id/deploy", async (c) => {
    const id = Number(c.req.param("id"));
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    if (!project) {
      return c.text("Not found", 404);
    }

    setImmediate(() => deployProject(db, docker, project.repo_url_norm));
    return c.html(await projectsTable(db));
  });

  router.post("/projects/:id/stop", async (c) => {
    const id = Number(c.req.param("id"));
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    if (!project) {
      return c.text("Not found", 404);
    }
    await safeStop(docker, project.container_name);
    if (project.mongo_container) {
      await safeStop(docker, project.mongo_container);
    }
    db.prepare("UPDATE projects SET status = 'stopped' WHERE id = ?").run(project.id);
    return c.html(await projectsTable(db));
  });

  router.post("/projects/:id/delete", async (c) => {
    const id = Number(c.req.param("id"));
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as any;
    if (!project) {
      return c.text("Not found", 404);
    }
    await safeRemove(docker, project.container_name);
    if (project.mongo_container) {
      await safeRemove(docker, project.mongo_container);
    }
    db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
    await removeCaddyBlock(project.domain);
    await reloadCaddy(docker);
    return c.html(await projectsTable(db));
  });

  router.get("/projects/:id/logs", (c) => {
    const id = Number(c.req.param("id"));
    const row = db.prepare("SELECT log, created_at FROM deploy_logs WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(id) as
      | { log: string; created_at: string }
      | undefined;
    if (!row) {
      return c.html("<div>No deploy logs yet.</div>");
    }
    return c.html(`<div><div class="mb-2 text-xs text-slate-500">Last deploy: ${row.created_at}</div><pre class="whitespace-pre-wrap">${escapeHtml(row.log)}</pre></div>`);
  });

  router.post("/settings/ssh", async (c) => {
    const body = await c.req.parseBody();
    const sshName = String(body.sshName || "").trim();
    const sshKey = String(body.sshKey || "").trim();
    if (!sshName || !sshKey) {
      return c.html(`<div id="ssh-status" class="text-sm text-rose-700">Name and key required.</div>`);
    }

    const existing = db.prepare("SELECT id FROM ssh_keys LIMIT 1").get() as { id: number } | undefined;
    if (existing) {
      return c.html(`<div id="ssh-status" class="text-sm text-rose-700">Key already saved. Delete it to replace.</div>`);
    }

    await ensureSshKey(sshKey);
    const fingerprint = createHash("sha256").update(sshKey).digest("hex");
    db.prepare("INSERT INTO ssh_keys (name, private_key) VALUES (?, ?)")
      .run(sshName, fingerprint);

    return c.html(`<div id="ssh-status" class="text-sm text-emerald-700">SSH key saved and locked.</div>`);
  });

  router.delete("/settings/ssh", async (c) => {
    db.prepare("DELETE FROM ssh_keys").run();
    await deleteSshKey();
    return c.html(`<div id="ssh-status" class="text-sm text-emerald-700">SSH key deleted.</div>`);
  });

  router.post("/settings/ssh/test", async (c) => {
    try {
      const result = await testGithubSsh();
      if (result.ok) {
        return c.html(`<div id="ssh-status" class="text-sm text-emerald-700">SSH OK: ${escapeHtml(result.output || "Authenticated")}</div>`);
      }
      return c.html(`<div id="ssh-status" class="text-sm text-rose-700">SSH failed: ${escapeHtml(result.output || "Unknown error")}</div>`);
    } catch (error) {
      return c.html(`<div id="ssh-status" class="text-sm text-rose-700">SSH test error.</div>`);
    }
  });

  router.post("/settings/basic-auth", async (c) => {
    const body = await c.req.parseBody();
    const enabled = body.enabled === "on";
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("basic_auth_enabled", String(enabled));
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("basic_auth_user", username);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("basic_auth_pass", password);

    return c.html(`<div id="basic-auth-status" class="text-sm text-emerald-700">Saved.</div>`);
  });

  router.get("/settings/ssh", (c) => {
    const existing = db.prepare("SELECT name FROM ssh_keys LIMIT 1").get() as { name: string } | undefined;
    const lockedNotice = existing
      ? `<div class="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Active key: ${existing.name}. This key is locked and can only be deleted.</div>`
      : "";
    const body = `
      <section class="max-w-2xl space-y-4">
        <h2 class="text-xl font-semibold">SSH Configuration</h2>
        ${lockedNotice}
        <form class="rounded border bg-white p-4 space-y-3" hx-post="/settings/ssh" hx-target="#ssh-status" hx-swap="outerHTML">
          <label class="block text-sm">Key Name
            <input name="sshName" class="mt-1 w-full rounded border px-3 py-2" placeholder="GitHub Org" ${existing ? "disabled" : ""} />
          </label>
          <label class="block text-sm">Private SSH Key
            <textarea name="sshKey" rows="10" class="mt-1 w-full rounded border px-3 py-2" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" ${existing ? "disabled" : ""}></textarea>
          </label>
          <div class="text-xs text-slate-500">Once saved, the key is locked and can only be deleted.</div>
          <div class="flex gap-2">
            <button class="rounded bg-slate-900 px-4 py-2 text-white" ${existing ? "disabled" : ""}>Save</button>
            <button class="rounded bg-rose-600 px-4 py-2 text-white" hx-delete="/settings/ssh" hx-target="#ssh-status" hx-swap="outerHTML" type="button">Delete</button>
          </div>
          <div id="ssh-status" class="text-sm text-slate-600"></div>
        </form>
      </section>
    `;
    return c.html(layout("SSH Configuration", body));
  });

  router.post("/webhook", async (c) => {
    const signature = c.req.header("x-hub-signature-256") || "";
    const secret = process.env.WEBHOOK_SECRET || "";
    const raw = await c.req.text();

    if (!verifySignature(raw, signature, secret)) {
      return c.text("Invalid signature", 401);
    }

    const payload = JSON.parse(raw);
    const repoUrl = payload?.repository?.ssh_url || payload?.repository?.clone_url;
    if (!repoUrl) {
      return c.text("No repo", 400);
    }

    const normalizedRepo = normalizeRepoUrl(repoUrl);
    const project = db.prepare("SELECT * FROM projects WHERE repo_url_norm = ?").get(normalizedRepo) as any;
    if (!project) {
      return c.text("Project not registered", 404);
    }

    setImmediate(() => deployProject(db, docker, normalizedRepo));
    return c.text("Deploy queued");
  });

  router.post("/ops/apps/start", async (c) => {
    await startAllApps(db, docker);
    return c.html(`<div id="ops-status" class="text-sm text-emerald-700">All apps started.</div>`);
  });

  router.post("/ops/apps/stop", async (c) => {
    await stopAllApps(db, docker);
    return c.html(`<div id="ops-status" class="text-sm text-amber-700">All apps stopped.</div>`);
  });

  router.post("/ops/prune/images", async (c) => {
    await docker.pruneImages({});
    return c.html(`<div id="ops-status" class="text-sm text-emerald-700">Images pruned.</div>`);
  });

  router.post("/ops/prune/containers", async (c) => {
    await docker.pruneContainers({});
    return c.html(`<div id="ops-status" class="text-sm text-emerald-700">Containers pruned.</div>`);
  });

  router.post("/ops/prune/volumes", async (c) => {
    await docker.pruneVolumes({});
    return c.html(`<div id="ops-status" class="text-sm text-emerald-700">Volumes pruned.</div>`);
  });

  router.post("/ops/prune/networks", async (c) => {
    await docker.pruneNetworks({});
    return c.html(`<div id="ops-status" class="text-sm text-emerald-700">Networks pruned.</div>`);
  });

  router.post("/ops/prune/all", async (c) => {
    await docker.pruneContainers({});
    await docker.pruneImages({});
    await docker.pruneVolumes({});
    await docker.pruneNetworks({});
    return c.html(`<div id="ops-status" class="text-sm text-emerald-700">All prune operations completed.</div>`);
  });

  router.get("/central-db/form", (c) => {
    const type = String(c.req.query("dbType") || "mongodb").toLowerCase();
    return c.html(renderCentralDbFields(type));
  });

  router.get("/central-db/partial", async (c) => {
    return c.html(await renderCentralDbList(db, docker));
  });

  router.post("/central-db", async (c) => {
    const body = await c.req.parseBody();
    const type = String(body.dbType || "mongodb").toLowerCase();
    const name = String(body.name || "").trim();
    const port = Number(body.port || (type === "postgres" ? 5432 : 27017));
    const uiPort = Number(body.uiPort || (type === "postgres" ? 5050 : 8081));
    const dbUser = String(body.dbUser || "").trim();
    const dbPass = String(body.dbPass || "").trim();
    const dbName = String(body.dbName || "").trim();
    const uiUser = String(body.uiUser || "").trim();
    const uiPass = String(body.uiPass || "").trim();

    if (!name) {
      return c.html(`<div id="central-db-status" class="text-sm text-rose-700">Container name is required.</div>`);
    }

    if (type === "postgres" && (!dbUser || !dbPass || !dbName || !uiUser || !uiPass)) {
      return c.html(`<div id="central-db-status" class="text-sm text-rose-700">Postgres and PgAdmin credentials are required.</div>`);
    }

    if (type === "mongodb" && (!dbUser || !dbPass || !uiUser || !uiPass)) {
      return c.html(`<div id="central-db-status" class="text-sm text-rose-700">MongoDB and Mongo Express credentials are required.</div>`);
    }

    const networkName = process.env.DOOD_NETWORK || "dood-net";
    await ensureNetwork(docker, networkName);

    const volumeName = `${name}-data`;
    await ensureVolume(docker, volumeName);

    const uiContainer = type === "postgres" ? `${name}-pgadmin` : `${name}-mongo-express`;

    const nameTaken = db.prepare("SELECT id FROM central_dbs WHERE name = ?").get(name) as
      | { id: number }
      | undefined;
    if (nameTaken) {
      return c.html(`<div id="central-db-status" class="text-sm text-rose-700">Container name already used.</div>`);
    }

    if (type === "postgres") {
      await ensureCentralPostgres(docker, networkName, {
        name,
        port,
        volumeName,
        username: dbUser,
        password: dbPass,
        databaseName: dbName,
      });
    } else {
      await ensureCentralMongo(docker, networkName, {
        name,
        port,
        volumeName,
        username: dbUser,
        password: dbPass,
      });
    }

    db.prepare(
      `INSERT INTO central_dbs (type, name, port, username, password, database_name, ui_port, ui_username, ui_password, ui_container, volume_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(type, name, port, dbUser || null, dbPass || null, dbName || null, uiPort, uiUser || null, uiPass || null, uiContainer, volumeName);

    return c.html(`<div id="central-db-status" class="text-sm text-emerald-700">Central database provisioned.</div><script>htmx.ajax('GET','/central-db/partial','#central-db-list')</script>`);
  });

  router.post("/central-db/:id/start", async (c) => {
    const id = Number(c.req.param("id"));
    const centralDb = getCentralDbById(db, id);
    if (!centralDb) {
      return c.html(`<div id="central-db-list" class="text-sm text-rose-700">Central DB not found.</div>`);
    }
    const networkName = process.env.DOOD_NETWORK || "dood-net";
    await ensureNetwork(docker, networkName);
    await ensureVolume(docker, centralDb.volume_name || `${centralDb.name}-data`);
    if (centralDb.type === "postgres") {
      await ensureCentralPostgres(docker, networkName, {
        name: centralDb.name,
        port: centralDb.port,
        volumeName: centralDb.volume_name || `${centralDb.name}-data`,
        username: centralDb.username || "postgres",
        password: centralDb.password || "postgres",
        databaseName: centralDb.database_name || "app",
      });
    } else {
      await ensureCentralMongo(docker, networkName, {
        name: centralDb.name,
        port: centralDb.port,
        volumeName: centralDb.volume_name || `${centralDb.name}-data`,
        username: centralDb.username || "root",
        password: centralDb.password || "root",
      });
    }
    return c.html(await renderCentralDbList(db, docker));
  });

  router.post("/central-db/:id/stop", async (c) => {
    const id = Number(c.req.param("id"));
    const centralDb = getCentralDbById(db, id);
    if (!centralDb) {
      return c.html(`<div id="central-db-list" class="text-sm text-rose-700">Central DB not found.</div>`);
    }
    await safeStop(docker, centralDb.name);
    return c.html(await renderCentralDbList(db, docker));
  });

  router.post("/central-db/:id/ui/start", async (c) => {
    const id = Number(c.req.param("id"));
    const centralDb = getCentralDbById(db, id);
    if (!centralDb) {
      return c.html(`<div id="central-db-list" class="text-sm text-rose-700">Central DB not found.</div>`);
    }
    const networkName = process.env.DOOD_NETWORK || "dood-net";
    await ensureNetwork(docker, networkName);
    if (centralDb.type === "postgres") {
      await ensurePgAdmin(docker, networkName, {
        name: centralDb.ui_container || `${centralDb.name}-pgadmin`,
        port: centralDb.ui_port || 5050,
        email: centralDb.ui_username || "admin@local",
        password: centralDb.ui_password || "admin",
      });
    } else {
      await ensureMongoExpress(docker, networkName, {
        name: centralDb.ui_container || `${centralDb.name}-mongo-express`,
        port: centralDb.ui_port || 8081,
        mongoHost: centralDb.name,
        uiUser: centralDb.ui_username || "admin",
        uiPass: centralDb.ui_password || "admin",
        mongoUser: centralDb.username || "root",
        mongoPass: centralDb.password || "root",
      });
    }
    return c.html(await renderCentralDbList(db, docker));
  });

  router.post("/central-db/:id/ui/stop", async (c) => {
    const id = Number(c.req.param("id"));
    const centralDb = getCentralDbById(db, id);
    if (!centralDb) {
      return c.html(`<div id="central-db-list" class="text-sm text-rose-700">Central DB not found.</div>`);
    }
    const uiName = centralDb.ui_container || (centralDb.type === "postgres" ? `${centralDb.name}-pgadmin` : `${centralDb.name}-mongo-express`);
    await safeStop(docker, uiName);
    return c.html(await renderCentralDbList(db, docker));
  });

  router.delete("/central-db/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const centralDb = getCentralDbById(db, id);
    if (!centralDb) {
      return c.html(`<div id="central-db-list" class="text-sm text-rose-700">Central DB not found.</div>`);
    }
    const uiName = centralDb.ui_container || (centralDb.type === "postgres" ? `${centralDb.name}-pgadmin` : `${centralDb.name}-mongo-express`);
    await safeRemove(docker, uiName);
    await safeRemove(docker, centralDb.name);
    db.prepare("DELETE FROM central_dbs WHERE id = ?").run(id);
    return c.html(await renderCentralDbList(db, docker));
  });

  return router;
}

async function projectsTable(db: Database.Database) {
  const projects = db.prepare("SELECT * FROM projects ORDER BY id DESC").all();
  const rows = projects
    .map(
      (project: any) => `
      <tr class="border-b">
        <td class="px-4 py-3 font-medium">${project.repo_url}</td>
        <td class="px-4 py-3">${project.status || "stopped"}</td>
        <td class="px-4 py-3">${project.port}</td>
        <td class="px-4 py-3">${project.domain}</td>
        <td class="px-4 py-3">
          <div class="flex flex-wrap gap-2">
            <button
              class="rounded bg-slate-900 px-3 py-1 text-white"
              hx-post="/projects/${project.id}/deploy"
              hx-target="#projects-table"
              hx-swap="outerHTML"
            >Deploy</button>
            <button
              class="rounded bg-amber-600 px-3 py-1 text-white"
              hx-post="/projects/${project.id}/stop"
              hx-target="#projects-table"
              hx-swap="outerHTML"
            >Stop</button>
            <button
              class="rounded bg-rose-600 px-3 py-1 text-white"
              hx-post="/projects/${project.id}/delete"
              hx-target="#projects-table"
              hx-swap="outerHTML"
            >Delete</button>
            <button
              class="rounded bg-slate-700 px-3 py-1 text-white"
              hx-get="/projects/${project.id}/logs"
              hx-target="#deploy-log"
              hx-swap="innerHTML"
            >Logs</button>
          </div>
        </td>
      </tr>
    `
    )
    .join("");

  return `
    <div id="projects-table" class="overflow-x-auto rounded border bg-white">
      <table class="w-full text-sm">
        <thead class="bg-slate-100 text-left">
          <tr>
            <th class="px-4 py-3">Repository</th>
            <th class="px-4 py-3">Status</th>
            <th class="px-4 py-3">Port</th>
            <th class="px-4 py-3">Domain</th>
            <th class="px-4 py-3">Action</th>
          </tr>
        </thead>
        <tbody>
          ${rows || "<tr><td class=\"px-4 py-3\" colspan=\"5\">No projects yet.</td></tr>"}
        </tbody>
      </table>
    </div>
    <div id="deploy-log" class="mt-3 rounded border bg-white p-3 text-xs text-slate-700">Select a project to view deploy logs.</div>
  `;
}

async function deployProject(db: Database.Database, docker: Docker, normalizedRepo: string) {
  const project = db.prepare("SELECT * FROM projects WHERE repo_url_norm = ?").get(normalizedRepo) as any;
  if (!project) {
    return;
  }

  db.prepare("UPDATE projects SET status = 'deploying' WHERE id = ?").run(project.id);
  let deployLog = "";

  try {
    const repoPath = join(REPOS_DIR, String(project.id));
    await mkdir(repoPath, { recursive: true });
    await cloneOrPull(project.repo_url, repoPath);

    await ensureDockerfile(repoPath);
    deployLog += await buildImage(docker, repoPath, project.image_tag);

    await stopAndRemoveContainer(docker, project.container_name);

    const networkName = process.env.DOOD_NETWORK || "dood-net";
    await ensureNetwork(docker, networkName);

    const container = await docker.createContainer({
      name: project.container_name,
      Image: project.image_tag,
      ExposedPorts: {
        [`${project.port}/tcp`]: {},
      },
      Env: project.mongo_container
        ? [`MONGODB_URL=mongodb://${project.mongo_container}:27017`]
        : [],
      HostConfig: {
        RestartPolicy: { Name: "always" },
        PortBindings: {
          [`${project.port}/tcp`]: [{ HostPort: String(project.port) }],
        },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {},
        },
      },
    });

    if (project.mongo_container) {
      await connectToNetwork(docker, project.mongo_container, networkName);
    }

    await container.start();

    db.prepare("UPDATE projects SET status = 'running' WHERE id = ?").run(project.id);
    await upsertCaddyBlock(project.domain, project.port);

    await docker.pruneImages({ filters: { dangling: { "true": true } } });
  } catch (error) {
    deployLog += `\nERROR: ${String(error)}`;
    db.prepare("UPDATE projects SET status = 'error' WHERE id = ?").run(project.id);
  } finally {
    if (deployLog) {
      const trimmed = deployLog.slice(-20000);
      db.prepare("INSERT INTO deploy_logs (project_id, log) VALUES (?, ?)").run(project.id, trimmed);
    }
  }
}

async function startAllApps(db: Database.Database, docker: Docker) {
  const projects = db.prepare("SELECT container_name, mongo_container FROM projects").all() as Array<{ container_name: string; mongo_container: string | null }>;
  for (const project of projects) {
    await safeStart(docker, project.container_name);
    if (project.mongo_container) {
      await safeStart(docker, project.mongo_container);
    }
  }
}

async function stopAllApps(db: Database.Database, docker: Docker) {
  const projects = db.prepare("SELECT container_name, mongo_container FROM projects").all() as Array<{ container_name: string; mongo_container: string | null }>;
  for (const project of projects) {
    await safeStop(docker, project.container_name);
    if (project.mongo_container) {
      await safeStop(docker, project.mongo_container);
    }
  }
}

async function safeStart(docker: Docker, name: string) {
  try {
    const container = docker.getContainer(name);
    await container.start();
  } catch {
    return;
  }
}

async function safeStop(docker: Docker, name: string) {
  try {
    const container = docker.getContainer(name);
    await container.stop();
  } catch {
    return;
  }
}

async function getContainerStatus(docker: Docker, name: string) {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    return info.State?.Status || "unknown";
  } catch {
    return "not-found";
  }
}

async function safeRemove(docker: Docker, name: string) {
  try {
    const container = docker.getContainer(name);
    await container.stop();
    await container.remove({ force: true });
  } catch {
    return;
  }
}

async function ensureDockerfile(repoPath: string) {
  try {
    await access(join(repoPath, "Dockerfile"));
  } catch {
    await writeFile(join(repoPath, "Dockerfile"), DOCKERFILE_TEMPLATE, "utf8");
  }
}

async function buildImage(docker: Docker, repoPath: string, tag: string) {
  const logs: string[] = [];
  const stream = await docker.buildImage(tar.pack(repoPath), { t: tag });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
      (event: any) => {
        if (event?.stream) logs.push(event.stream);
        if (event?.error) logs.push(event.error);
        if (event?.status) logs.push(`${event.status} ${event.progress || ""}`.trim() + "\n");
      }
    );
  });
  return logs.join("");
}

async function stopAndRemoveContainer(docker: Docker, name: string) {
  try {
    const container = docker.getContainer(name);
    try {
      await container.stop();
    } catch {
      // ignore
    }
    await container.remove({ force: true });
  } catch {
    return;
  }
}

async function ensureMongoContainer(docker: Docker, name: string) {
  try {
    const existing = docker.getContainer(name);
    await existing.inspect();
    return;
  } catch {
    // continue
  }

  const networkName = process.env.DOOD_NETWORK || "dood-net";
  await ensureNetwork(docker, networkName);

  const container = await docker.createContainer({
    name,
    Image: "mongo:7",
    HostConfig: {
      RestartPolicy: { Name: "always" },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
  });

  await container.start();
}

async function ensureCentralMongo(
  docker: Docker,
  networkName: string,
  config: { name: string; port: number; volumeName: string; username: string; password: string }
) {
  try {
    const existing = docker.getContainer(config.name);
    const info = await existing.inspect();
    if (info.State?.Status !== "running") {
      await existing.start();
    }
    return;
  } catch {
    // continue
  }

  const container = await docker.createContainer({
    name: config.name,
    Image: "mongo:7",
    Env: [
      `MONGO_INITDB_ROOT_USERNAME=${config.username}`,
      `MONGO_INITDB_ROOT_PASSWORD=${config.password}`,
    ],
    ExposedPorts: {
      "27017/tcp": {},
    },
    HostConfig: {
      RestartPolicy: { Name: "always" },
      PortBindings: {
        "27017/tcp": [{ HostPort: String(config.port) }],
      },
      Binds: [`${config.volumeName}:/data/db`],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
  });

  await container.start();
}

async function ensureCentralPostgres(
  docker: Docker,
  networkName: string,
  config: { name: string; port: number; volumeName: string; username: string; password: string; databaseName: string }
) {
  try {
    const existing = docker.getContainer(config.name);
    const info = await existing.inspect();
    if (info.State?.Status !== "running") {
      await existing.start();
    }
    return;
  } catch {
    // continue
  }

  const container = await docker.createContainer({
    name: config.name,
    Image: "postgres:16",
    Env: [
      `POSTGRES_USER=${config.username}`,
      `POSTGRES_PASSWORD=${config.password}`,
      `POSTGRES_DB=${config.databaseName}`,
    ],
    ExposedPorts: {
      "5432/tcp": {},
    },
    HostConfig: {
      RestartPolicy: { Name: "always" },
      PortBindings: {
        "5432/tcp": [{ HostPort: String(config.port) }],
      },
      Binds: [`${config.volumeName}:/var/lib/postgresql/data`],
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
  });

  await container.start();
}

async function ensureMongoExpress(
  docker: Docker,
  networkName: string,
  config: { name: string; port: number; mongoHost: string; uiUser: string; uiPass: string; mongoUser: string; mongoPass: string }
) {
  try {
    const existing = docker.getContainer(config.name);
    const info = await existing.inspect();
    if (info.State?.Status !== "running") {
      await existing.start();
    }
    return;
  } catch {
    // continue
  }

  const container = await docker.createContainer({
    name: config.name,
    Image: "mongo-express:1.0.2-20",
    Env: [
      `ME_CONFIG_MONGODB_URL=mongodb://${config.mongoHost}:27017`,
      `ME_CONFIG_MONGODB_ADMINUSERNAME=${config.mongoUser}`,
      `ME_CONFIG_MONGODB_ADMINPASSWORD=${config.mongoPass}`,
      `ME_CONFIG_BASICAUTH_USERNAME=${config.uiUser}`,
      `ME_CONFIG_BASICAUTH_PASSWORD=${config.uiPass}`,
    ],
    ExposedPorts: {
      "8081/tcp": {},
    },
    HostConfig: {
      RestartPolicy: { Name: "always" },
      PortBindings: {
        "8081/tcp": [{ HostPort: String(config.port) }],
      },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
  });

  await container.start();
}

async function ensurePgAdmin(
  docker: Docker,
  networkName: string,
  config: { name: string; port: number; email: string; password: string }
) {
  try {
    const existing = docker.getContainer(config.name);
    const info = await existing.inspect();
    if (info.State?.Status !== "running") {
      await existing.start();
    }
    return;
  } catch {
    // continue
  }

  const container = await docker.createContainer({
    name: config.name,
    Image: "dpage/pgadmin4:8",
    Env: [
      `PGADMIN_DEFAULT_EMAIL=${config.email}`,
      `PGADMIN_DEFAULT_PASSWORD=${config.password}`,
      "PGADMIN_CONFIG_SERVER_MODE=True",
    ],
    ExposedPorts: {
      "80/tcp": {},
    },
    HostConfig: {
      RestartPolicy: { Name: "always" },
      PortBindings: {
        "80/tcp": [{ HostPort: String(config.port) }],
      },
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: {},
      },
    },
  });

  await container.start();
}

async function ensureVolume(docker: Docker, name: string) {
  try {
    await docker.getVolume(name).inspect();
  } catch {
    await docker.createVolume({ Name: name });
  }
}

async function ensureNetwork(docker: Docker, name: string) {
  const networks = await docker.listNetworks();
  if (networks.some((net: { Name?: string }) => net.Name === name)) {
    return;
  }
  await docker.createNetwork({ Name: name, CheckDuplicate: true });
}

async function connectToNetwork(docker: Docker, containerName: string, networkName: string) {
  try {
    const network = docker.getNetwork(networkName);
    await network.connect({ Container: containerName });
  } catch {
    return;
  }
}

async function upsertCaddyBlock(domain: string, port: number) {
  const block = `\n${domain} {\n    encode zstd gzip\n    header {\n        Strict-Transport-Security \"max-age=31536000; includeSubDomains; preload\"\n        X-Content-Type-Options \"nosniff\"\n        X-Frame-Options \"DENY\"\n        Referrer-Policy \"no-referrer\"\n        Permissions-Policy \"geolocation=(), microphone=(), camera=()\"\n    }\n    reverse_proxy localhost:${port}\n}\n`;
  await mkdir("/etc/caddy", { recursive: true });
  let content = "";
  try {
    content = await readFile("/etc/caddy/Caddyfile", "utf8");
  } catch {
    content = "";
  }
  const pattern = new RegExp(`\\n?${escapeRegex(domain)}\\s*\\{[\\s\\S]*?\\n\\}\\n?`, "g");
  const cleaned = content.replace(pattern, "\n");
  await writeFile("/etc/caddy/Caddyfile", cleaned + block, "utf8");
}

async function removeCaddyBlock(domain: string) {
  await mkdir("/etc/caddy", { recursive: true });
  let content = "";
  try {
    content = await readFile("/etc/caddy/Caddyfile", "utf8");
  } catch {
    content = "";
  }
  const pattern = new RegExp(`\\n?${escapeRegex(domain)}\\s*\\{[\\s\\S]*?\\n\\}\\n?`, "g");
  const cleaned = content.replace(pattern, "\n");
  await writeFile("/etc/caddy/Caddyfile", cleaned, "utf8");
}

async function reloadCaddy(docker: Docker) {
  const caddyName = process.env.CADDY_CONTAINER_NAME || "caddy";
  const container = docker.getContainer(caddyName);
  const exec = await container.exec({
    Cmd: ["caddy", "reload"],
    AttachStdout: true,
    AttachStderr: true,
  });

  await new Promise<void>((resolve, reject) => {
    exec.start({}, (err: Error | null, stream?: NodeJS.ReadableStream) => {
      if (err || !stream) {
        reject(err || new Error("caddy reload stream missing"));
        return;
      }
      stream.on("end", resolve);
      stream.on("error", reject);
    });
  });
}

function getCentralDbs(db: Database.Database) {
  return db.prepare("SELECT * FROM central_dbs ORDER BY id DESC").all() as Array<{
    id: number;
    type: string;
    name: string;
    port: number;
    username: string | null;
    password: string | null;
    database_name: string | null;
    ui_port: number | null;
    ui_username: string | null;
    ui_password: string | null;
    ui_container: string | null;
    volume_name: string | null;
  }>;
}

function getCentralDbById(db: Database.Database, id: number) {
  const row = db.prepare("SELECT * FROM central_dbs WHERE id = ?").get(id) as
    | {
        id: number;
        type: string;
        name: string;
        port: number;
        username: string | null;
        password: string | null;
        database_name: string | null;
        ui_port: number | null;
        ui_username: string | null;
        ui_password: string | null;
        ui_container: string | null;
        volume_name: string | null;
      }
    | undefined;
  return row || null;
}

function renderCentralDbFields(type: string) {
  if (type === "postgres") {
    return `
      <label class="block text-sm">Container Name
        <input name="name" class="mt-1 w-full rounded border px-3 py-2" placeholder="central-postgres" required />
      </label>
      <label class="block text-sm">Postgres Port
        <input name="port" type="number" class="mt-1 w-full rounded border px-3 py-2" placeholder="5432" value="5432" required />
      </label>
      <label class="block text-sm">DB Username
        <input name="dbUser" class="mt-1 w-full rounded border px-3 py-2" placeholder="postgres" required />
      </label>
      <label class="block text-sm">DB Password
        <input name="dbPass" type="password" class="mt-1 w-full rounded border px-3 py-2" placeholder="password" required />
      </label>
      <label class="block text-sm">DB Name
        <input name="dbName" class="mt-1 w-full rounded border px-3 py-2" placeholder="app" required />
      </label>
      <label class="block text-sm">PgAdmin Port
        <input name="uiPort" type="number" class="mt-1 w-full rounded border px-3 py-2" placeholder="5050" value="5050" required />
      </label>
      <label class="block text-sm">PgAdmin Email
        <input name="uiUser" type="email" class="mt-1 w-full rounded border px-3 py-2" placeholder="admin@local" required />
      </label>
      <label class="block text-sm">PgAdmin Password
        <input name="uiPass" type="password" class="mt-1 w-full rounded border px-3 py-2" placeholder="admin" required />
      </label>
    `;
  }

  return `
    <label class="block text-sm">Container Name
      <input name="name" class="mt-1 w-full rounded border px-3 py-2" placeholder="central-mongo" required />
    </label>
    <label class="block text-sm">MongoDB Port
      <input name="port" type="number" class="mt-1 w-full rounded border px-3 py-2" placeholder="27017" value="27017" required />
    </label>
    <label class="block text-sm">Mongo Root Username
      <input name="dbUser" class="mt-1 w-full rounded border px-3 py-2" placeholder="root" required />
    </label>
    <label class="block text-sm">Mongo Root Password
      <input name="dbPass" type="password" class="mt-1 w-full rounded border px-3 py-2" placeholder="strong-password" required />
    </label>
    <label class="block text-sm">Mongo Express Port
      <input name="uiPort" type="number" class="mt-1 w-full rounded border px-3 py-2" placeholder="8081" value="8081" required />
    </label>
    <label class="block text-sm">Mongo Express Username
      <input name="uiUser" class="mt-1 w-full rounded border px-3 py-2" placeholder="admin" required />
    </label>
    <label class="block text-sm">Mongo Express Password
      <input name="uiPass" type="password" class="mt-1 w-full rounded border px-3 py-2" placeholder="admin" required />
    </label>
  `;
}

async function renderCentralDbList(db: Database.Database, docker: Docker) {
  const centralDbs = getCentralDbs(db);
  if (centralDbs.length === 0) {
    return `<div id="central-db-list" class="text-sm text-slate-600">No central databases yet.</div>`;
  }

  const rows = await Promise.all(
    centralDbs.map(async (centralDb) => {
      const dbStatus = await getContainerStatus(docker, centralDb.name);
      const uiName = centralDb.ui_container || (centralDb.type === "postgres" ? `${centralDb.name}-pgadmin` : `${centralDb.name}-mongo-express`);
      const uiStatus = await getContainerStatus(docker, uiName);
      const uiLabel = centralDb.type === "postgres" ? "PgAdmin" : "Mongo Express";
      const safeName = escapeHtml(centralDb.name);
      return `
        <tr class="border-b">
          <td class="px-3 py-2 font-medium">${safeName}</td>
          <td class="px-3 py-2">${centralDb.type}</td>
          <td class="px-3 py-2">${centralDb.port}</td>
          <td class="px-3 py-2">${dbStatus}</td>
          <td class="px-3 py-2">${uiStatus}</td>
          <td class="px-3 py-2">
            <div class="flex flex-wrap gap-2">
              <button class="rounded bg-slate-900 px-3 py-1 text-white" hx-post="/central-db/${centralDb.id}/start" hx-target="#central-db-list" hx-swap="outerHTML">Start DB</button>
              <button class="rounded bg-amber-600 px-3 py-1 text-white" hx-post="/central-db/${centralDb.id}/stop" hx-target="#central-db-list" hx-swap="outerHTML">Stop DB</button>
              <button class="rounded bg-slate-700 px-3 py-1 text-white" hx-post="/central-db/${centralDb.id}/ui/start" hx-target="#central-db-list" hx-swap="outerHTML">Start ${uiLabel}</button>
              <button class="rounded bg-slate-700 px-3 py-1 text-white" hx-post="/central-db/${centralDb.id}/ui/stop" hx-target="#central-db-list" hx-swap="outerHTML">Stop ${uiLabel}</button>
              <button class="rounded bg-rose-600 px-3 py-1 text-white" hx-delete="/central-db/${centralDb.id}" hx-target="#central-db-list" hx-swap="outerHTML">Delete</button>
            </div>
          </td>
        </tr>
      `;
    })
  );

  return `
    <div id="central-db-list" class="overflow-x-auto rounded border bg-white">
      <table class="w-full text-sm">
        <thead class="bg-slate-100 text-left">
          <tr>
            <th class="px-3 py-2">Name</th>
            <th class="px-3 py-2">Type</th>
            <th class="px-3 py-2">Port</th>
            <th class="px-3 py-2">DB Status</th>
            <th class="px-3 py-2">UI Status</th>
            <th class="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </div>
  `;
}

function normalizeRepoUrl(repoUrl: string) {
  const cleaned = repoUrl.replace(/\.git$/, "");
  if (cleaned.startsWith("https://github.com/")) {
    return `git@github.com:${cleaned.slice("https://github.com/".length)}`.toLowerCase();
  }
  if (cleaned.startsWith("http://github.com/")) {
    return `git@github.com:${cleaned.slice("http://github.com/".length)}`.toLowerCase();
  }
  return cleaned.toLowerCase();
}

function verifySignature(rawBody: string, signature: string, secret: string) {
  if (!signature || !secret) {
    return false;
  }
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}

function getSetting(db: Database.Database, key: string) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value || "";
}

function checkBasicAuth(header: string, user: string, pass: string) {
  if (!user || !pass) return false;
  if (!header.startsWith("Basic ")) return false;
  const raw = Buffer.from(header.slice(6), "base64").toString("utf8");
  const [u, p] = raw.split(":");
  const ub = Buffer.from(u || "");
  const pb = Buffer.from(p || "");
  const userb = Buffer.from(user);
  const passb = Buffer.from(pass);
  if (ub.length !== userb.length || pb.length !== passb.length) {
    return false;
  }
  return timingSafeEqual(ub, userb) && timingSafeEqual(pb, passb);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getSession(db: Database.Database, cookieHeader: string) {
  const cookies = parseCookies(cookieHeader);
  const token = cookies["dood_session"];
  if (!token) return null;
  const row = db.prepare("SELECT user_id FROM sessions WHERE token = ?").get(token) as
    | { user_id: number }
    | undefined;
  return row ? { userId: row.user_id } : null;
}

function createSession(db: Database.Database, userId: number) {
  const token = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (user_id, token) VALUES (?, ?)").run(userId, token);
  return token;
}

function setSessionCookie(c: any, token: string) {
  c.header("Set-Cookie", `dood_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSessionCookie(c: any) {
  c.header("Set-Cookie", "dood_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}

function parseCookies(header: string) {
  const cookies: Record<string, string> = {};
  header.split(";").forEach((cookie) => {
    const [key, ...rest] = cookie.trim().split("=");
    if (!key) return;
    cookies[key] = rest.join("=");
  });
  return cookies;
}

function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, salt: string, hash: string) {
  const candidate = pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(hash));
}
