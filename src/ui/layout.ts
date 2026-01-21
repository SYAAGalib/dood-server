export function layout(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/htmx.org@1.9.12"></script>
  </head>
  <body class="bg-slate-50 text-slate-900">
    <div class="min-h-screen">
      <header class="border-b bg-white">
        <div class="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
          <h1 class="text-2xl font-semibold">DooD Serve</h1>
          <span class="text-sm text-slate-500">Lightweight self-hosted PaaS</span>
        </div>
      </header>
      <main class="mx-auto max-w-6xl px-6 py-6">
        ${body}
      </main>
    </div>
  </body>
</html>`;
}
