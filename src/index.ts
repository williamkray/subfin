/**
 * Subfin: OpenSubsonic-to-Jellyfin compatibility layer.
 * Usage: npm run build && npm start
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { config } from "./config.js";
import { clientIpMiddleware } from "./request-context.js";
import { subsonicRouter } from "./subsonic/router.js";
import { webRouter } from "./web/router.js";
import { getDb } from "./store/index.js";

// Ensure store is initialized (SQLite + optional migration from legacy JSON)
getDb();

const app = express();

const trustProxy = process.env.SUBFIN_TRUST_PROXY === "true" || process.env.SUBFIN_TRUST_PROXY === "1";
if (trustProxy) app.set("trust proxy", 1);

// Restrict CORS to the configured public URL when available; otherwise allow all origins
// (native Subsonic clients don't send Origin, so this only affects browser-initiated cross-origin requests).
const corsOrigin = config.subfinPublicUrl || "*";
app.use(cors({ origin: corsOrigin }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
}));
app.use(cookieParser());
app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));
// Set request-scoped client IP (X-Forwarded-For / X-Real-IP / remoteAddress) for Jellyfin outbound requests.
app.use(clientIpMiddleware);

// Subsonic REST: /rest/ping.view, /rest/getMusicFolders.view, /rest/stream, etc.
app.all(["/rest", "/rest/:method"], async (req, res) => {
  await subsonicRouter(req, res);
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
