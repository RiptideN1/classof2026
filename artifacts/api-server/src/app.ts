import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

import("@mercuryworkshop/scramjet/path").then((mod) => {
  const scramjetPath: string = (mod as Record<string, string>).scramjetPath;
  logger.info({ scramjetPath }, "Serving Scramjet static files at /scram");
  app.use("/scram", express.static(scramjetPath));
}).catch((err: unknown) => {
  logger.error({ err }, "Failed to load scramjet path");
});

import("@mercuryworkshop/bare-mux/node").then((mod) => {
  const baremuxPath: string = (mod as Record<string, string>).baremuxPath;
  logger.info({ baremuxPath }, "Serving BareMux static files at /baremux");
  app.use("/baremux", express.static(baremuxPath));
}).catch((err: unknown) => {
  logger.error({ err }, "Failed to load baremux path");
});

import("@mercuryworkshop/libcurl-transport").then((mod) => {
  const libcurlPath: string = (mod as Record<string, string>).libcurlPath;
  logger.info({ libcurlPath }, "Serving libcurl static files at /libcurl");
  app.use("/libcurl", express.static(libcurlPath));
}).catch((err: unknown) => {
  logger.error({ err }, "Failed to load libcurl path");
});

app.use("/api", router);

export default app;
