import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const consumer = mkdtempSync(join(tmpdir(), "better-auth-tauri-consumer-"));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("bun", ["run", "build"]);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], { cwd: root, encoding: "utf8" }));
  // Reuse the reviewed dependency resolutions, but install all files afresh.
  const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
  copyFileSync(resolve("bun.lock"), join(consumer, "bun.lock"));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "packed-consumer", private: true, type: "module",
    dependencies: {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      "@dreamshive/better-auth-tauri": `file:./${packed[0].filename}`,
    },
  }, null, 2));
  copyFileSync(resolve("fixtures/packed-consumer/client.ts"), join(consumer, "client.ts"));
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", types: [] },
    include: ["client.ts"],
  }));
  // The requested compatibility target may still be inside a local release-age window.
  // Exempt only Better Auth; do not change the user's global install policy.
  writeFileSync(join(consumer, "bunfig.toml"), '[install]\nminimumReleaseAgeExcludes = ["better-auth", "@better-auth/*"]\n');
  // Resolve the freshly-packed file dependency into this consumer's lockfile,
  // then install from that lockfile so local build output cannot mask it.
  run("bun", ["install", "--lockfile-only", "--ignore-scripts"], consumer);
  run("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], consumer);
  writeFileSync(join(consumer, "version.ts"), `export const expectedVersion = ${JSON.stringify(manifest.version)};\n`);
  run("node", [join(consumer, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], consumer);
  run("bun", ["run", "client.ts"], consumer);
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
