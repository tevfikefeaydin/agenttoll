import app, { NETWORK } from "./app.js";

const PORT = Number(process.env.PORT ?? 4021);

app.listen(PORT, () => {
  console.log(`AgentToll listening on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
});
