import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { build } from "esbuild";

const result = await build({
  entryPoints: ["plugins/openobserve/src/index.ts"],
  outfile: "index.mjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  write: false,
});

const bundle = result.outputFiles[0]?.contents;
if (!bundle) throw new Error("esbuild did not produce the Codex hook bundle");

const digest = createHash("sha256").update(bundle).digest("hex").slice(0, 16);
const filename = `index.${digest}.mjs`;
const distDirectory = "plugins/openobserve/dist";
await mkdir(distDirectory, { recursive: true });
for (const entry of await readdir(distDirectory)) {
  if (/^index(?:\.[0-9a-f]{16})?\.mjs$/.test(entry) && entry !== filename) {
    await rm(`${distDirectory}/${entry}`);
  }
}
await writeFile(`${distDirectory}/${filename}`, bundle, { mode: 0o755 });

const hooksPath = "plugins/openobserve/hooks/hooks.json";
const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
const handler = hooks.hooks?.Stop?.[0]?.hooks?.[0];
if (!handler || handler.type !== "command") {
  throw new Error("Stop hook manifest does not contain the expected command handler");
}
handler.command = `node \"\${PLUGIN_ROOT}/dist/${filename}\"`;
handler.commandWindows = `node \"%PLUGIN_ROOT%\\dist\\${filename}\"`;
await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
