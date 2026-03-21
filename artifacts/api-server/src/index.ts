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

server.on("upgrade", async (req, socket, head) => {
  try {
    if (req.url && req.url.endsWith("/wisp/")) {
      const { server: wisp, logging } = await import("@mercuryworkshop/wisp-js/server");
      logging.set_level(logging.NONE);
      wisp.routeRequest(req, socket, head);
    } else {
      socket.end();
    }
  } catch (err) {
    logger.error({ err }, "Error handling WebSocket upgrade");
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
