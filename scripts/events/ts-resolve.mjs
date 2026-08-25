// Resolve hook so the plain-node test scripts can import the app's .ts modules
// with their normal extensionless specifiers (Next.js resolves those via bundler
// resolution; node's ESM resolver needs the help).
//
// Self-locating, so it works whichever directory npm runs it from.

import { register } from "node:module";

register("./ts-resolve-hooks.mjs", import.meta.url);
