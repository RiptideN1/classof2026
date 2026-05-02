import { createRequire } from "node:module";
import path from "node:path";
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const require = createRequire(import.meta.url);
const { scramjetPath } = require("@mercuryworkshop/scramjet/path") as {
  scramjetPath: string;
};
const { baremuxPath } = require("@mercuryworkshop/bare-mux/node") as {
  baremuxPath: string;
};
const { libcurlPath } = require("@mercuryworkshop/libcurl-transport") as {
  libcurlPath: string;
};
const proxyClientPath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "proxy",
  "dist",
  "public",
);
const serviceWorkerPath = path.join(proxyClientPath, "sw.js");

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  // Allow official third-party embeds like YouTube while keeping a stable browsing context.
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  next();
});

logger.info({ scramjetPath }, "Serving Scramjet static files at /scram");
app.use("/scram", express.static(scramjetPath));

logger.info({ baremuxPath }, "Serving BareMux static files at /baremux");
app.use("/baremux", express.static(baremuxPath));

logger.info({ libcurlPath }, "Serving libcurl static files at /libcurl");
app.use("/libcurl", express.static(libcurlPath));

app.use("/api", router);
app.get("/youtube-player", (req, res) => {
  const embed = typeof req.query.embed === "string" ? req.query.embed : "";
  const title =
    typeof req.query.title === "string" && req.query.title.trim()
      ? req.query.title.trim()
      : "YouTube player";

  if (!embed) {
    res.status(400).type("text/plain").send("Missing embed URL.");
    return;
  }

  let embedUrl: URL;

  try {
    embedUrl = new URL(embed);
  } catch {
    res.status(400).type("text/plain").send("Invalid embed URL.");
    return;
  }

  const hostname = embedUrl.hostname.replace(/^www\./, "").toLowerCase();
  const allowedHostnames = new Set(["youtube.com", "youtube-nocookie.com"]);

  if (embedUrl.protocol !== "https:" || !allowedHostnames.has(hostname)) {
    res.status(400).type("text/plain").send("Unsupported embed URL.");
    return;
  }

  res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; frame-src https://www.youtube.com https://www.youtube-nocookie.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: https:;",
  );

  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title.replace(/[<&>"]/g, "")}</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: #000;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        display: block;
      }
    </style>
  </head>
  <body>
    <iframe
      src="${embedUrl.toString()}"
      title="${title.replace(/[<&>"]/g, "")}"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin"
    ></iframe>
  </body>
</html>`);
});
app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(serviceWorkerPath);
});
app.use("/scramjet", (_req, res) => {
  res.status(502).type("text/plain").send(
    "Scramjet request reached the server instead of the service worker.",
  );
});
app.use(express.static(proxyClientPath));
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(proxyClientPath, "index.html"));
});

export default app;
