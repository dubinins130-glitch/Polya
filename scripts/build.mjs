import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { renderIcon } from "./icons.mjs";

const assets = ["manifest.json", "panel.html", "journal.html", "journal.js", "theme.css", "ui.css", "image.css", "highlight.css"];
const entries = ["worker", "content", "panel"];

await mkdir("dist/icons", { recursive: true });
await Promise.all([
  build({
    entryPoints: Object.fromEntries(entries.map((entry) => [entry, "src/" + entry + ".ts"])),
    outdir: "dist",
    bundle: true,
    format: "iife",
    target: "chrome116",
    loader: { ".css": "text" },
    legalComments: "eof",
    logLevel: "info",
  }),
  copyFile("LICENSE", "dist/LICENSE"),
  ...assets.map((name) => copyFile("static/" + name, "dist/" + name)),
  ...[16, 32, 48, 128].map((size) => writeFile("dist/icons/icon" + size + ".png", renderIcon(size))),
]);
