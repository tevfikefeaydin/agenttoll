import app, { NETWORK, PORT } from "./app.js";
import { readConfig } from "./config.js";
import { installShutdownHandlers } from "./server-lifecycle.js";


const server = app.listen(PORT, () => {
  console.log(`AgentToll listening on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
});

installShutdownHandlers(server, readConfig().requestTimeoutMs + 5_000);
