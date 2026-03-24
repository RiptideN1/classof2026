import { createRequire } from "node:module";
import path from "node:path";
import cookieParser from "cookie-parser";
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
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});

logger.info({ scramjetPath }, "Serving Scramjet static files at /scram");
app.use("/scram", express.static(scramjetPath));

logger.info({ baremuxPath }, "Serving BareMux static files at /baremux");
app.use("/baremux", express.static(baremuxPath));

logger.info({ libcurlPath }, "Serving libcurl static files at /libcurl");
app.use("/libcurl", express.static(libcurlPath));

app.use("/api", router);
app.get("/sw.js", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(serviceWorkerPath);
});
app.use(express.static(proxyClientPath));
app.get("/{*path}", (_req, res) => {
  res.sendFile(path.join(proxyClientPath, "index.html"));
});

export default app;
