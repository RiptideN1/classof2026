import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);

let wispRouteRequest: ((req: unknown, socket: unknown, head: unknown) => void) | null = null;

import("@mercuryworkshop/wisp-js/server").then((mod) => {
  const { server: wisp, logging } = mod as {
    server: { routeRequest: (req: unknown, socket: unknown, head: unknown) => void; options: Record<string, unknown> };
    logging: { set_level: (level: unknown) => void; NONE: unknown };
  };
  logging.set_level(logging.NONE);
  Object.assign(wisp.options, {
    allow_udp_streams: false,
    dns_servers: ["1.1.1.3", "1.0.0.3"],
  });
  wispRouteRequest = wisp.routeRequest.bind(wisp);
  logger.info("Wisp server ready for WebSocket connections at /wisp/");
}).catch((err: unknown) => {
  logger.error({ err }, "Failed to load wisp-js server");
});

server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.endsWith("/wisp/")) {
    if (wispRouteRequest) {
      wispRouteRequest(req, socket, head);
    } else {
      logger.warn("Wisp not ready yet, closing socket");
      socket.end();
    }
  } else {
    socket.end();
  }
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
