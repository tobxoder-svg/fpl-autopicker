// HiGHS ships its WebAssembly binary alongside its JS glue. Vite can't trace a
// runtime locateFile() call, so we copy the .wasm into public/ and load it from
// the site's base URL instead.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const src = resolve(dirname(require.resolve("highs")), "highs.wasm");
mkdirSync("public", { recursive: true });
copyFileSync(src, "public/highs.wasm");
console.log("copied highs.wasm -> public/highs.wasm");
