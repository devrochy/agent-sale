import { env } from "../config/env.js";
import { buildServer } from "./server.js";

const app = buildServer();

app.listen({ port: env.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
