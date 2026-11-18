// Builds the website into public/: the landing page (public/index.html) is kept as is,
// the planner app is copied from ui/index.html, and the shared text module is copied for the browser.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
copyFileSync("ui/index.html", "public/app.html");
mkdirSync("public/lib", { recursive: true });
writeFileSync("public/lib/text.js", readFileSync("src/text.mjs", "utf8").replace('from "./outbox.mjs"', 'from "./outbox.js"'));
copyFileSync("src/outbox.mjs", "public/lib/outbox.js");
if (existsSync("out/state.json")) copyFileSync("out/state.json", "public/demo-state.json");
console.log("Website built: public/index.html, public/app.html, public/lib/");
