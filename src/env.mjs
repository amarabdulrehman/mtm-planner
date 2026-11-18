// Loads .env (no dependency). Imported first by every entry point.
import { readFileSync, existsSync } from "node:fs";

const file = new URL("../.env", import.meta.url);
if (existsSync(file)) {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
