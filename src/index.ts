import app, { NETWORK, PORT } from "./app.js";


app.listen(PORT, () => {
  console.log(`AgentToll listening on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
});
