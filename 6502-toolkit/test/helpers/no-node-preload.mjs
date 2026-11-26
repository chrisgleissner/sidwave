// Preload for the browser-like test: removes Buffer and blocks node: imports in modules loaded afterwards.
import { register } from "node:module";

register("./no-node-hooks.mjs", import.meta.url);
delete globalThis.Buffer;
