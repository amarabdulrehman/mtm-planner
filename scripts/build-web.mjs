// Builds the website: public/index.html (landing) is kept as is; the planner app is copied from ui/index.html.
import { copyFileSync, existsSync } from "node:fs";
copyFileSync("ui/index.html", "public/app.html");
if (existsSync("out/state.json")) copyFileSync("out/state.json", "public/demo-state.json");
console.log("Website built: public/index.html, public/app.html");
