/**
 * Subfin: OpenSubsonic-to-Jellyfin compatibility layer.
 * Usage: npm run build && npm start
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { subsonicRouter } from "./subsonic/router.js";
import { webRouter } from "./web/router.js";
import { getDb } from "./store/index.js";

// Ensure store is initialized (SQLite + optional migration from legacy JSON)
getDb();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Subsonic REST: /rest/ping.view, /rest/getMusicFolders.view, /rest/stream, etc.
app.all(["/rest", "/rest/:method"], (req, res) => {
  subsonicRouter(req, res);
});

// Web UI: link, devices, unlink, reset password
app.use("/", webRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "subfin" });
});

const port = config.port;
app.listen(port, () => {
  console.log(`Subfin listening on http://localhost:${port}`);
  console.log(`  Subsonic REST: http://localhost:${port}/rest/`);
  console.log(`  Web UI:        http://localhost:${port}/`);
});
