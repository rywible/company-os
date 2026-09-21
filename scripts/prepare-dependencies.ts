import { cp, mkdir, realpath, rename } from "node:fs/promises";
import { dirname } from "node:path";
// @fly/sprites bundles this file: dependency; Bun can install self-referential
// links for it. Replace only that generated dependency with its vendored copy.
const target = "node_modules/@fly/sprites/node_modules/@fly/client-signals";
try {
  await realpath(`${target}/package.json`);
  await realpath(`${target}/src/index.js`);
} catch {
  await mkdir(dirname(target), {recursive:true});
  const staged = `${target}.prepared-${crypto.randomUUID()}`;
  await cp("node_modules/@fly/sprites/vendor/client-signals", staged, {recursive:true});
  try { await rename(target, `${target}.previous-${crypto.randomUUID()}`); }
  catch (error:any) { if(error.code !== "ENOENT") throw error; }
  await rename(staged,target);
}
