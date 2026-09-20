import { cp, rm, rename } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: ["./index.html"],
  outdir: "./dist",
  target: "browser",
  minify: true,
  splitting: true,
  publicPath: "/",
  naming: {
    entry: "assets/[name]-[hash].[ext]",
    chunk: "assets/[name]-[hash].[ext]",
    asset: "assets/[name]-[hash].[ext]",
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const html = result.outputs.find((output) => output.path.endsWith(".html"));
if (!html) throw new Error("Bun did not emit an HTML entrypoint");
await rename(html.path, "dist/index.html");
await cp("public", "dist", { recursive: true });
console.log(`Bun ${Bun.version}: built ${result.outputs.length} assets.`);
