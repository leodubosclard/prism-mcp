import "dotenv/config";
import express from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";

const { PRIM_API_KEY, MCP_SECRET } = process.env;
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

if (!PRIM_API_KEY) throw new Error("PRIM_API_KEY manquante (voir .env.example)");
if (!MCP_SECRET || MCP_SECRET.length < 24) throw new Error("MCP_SECRET manquant ou trop court (24 caractères min.)");

const secretBuf = Buffer.from(MCP_SECRET);
const validSecret = (s: string) => {
  const b = Buffer.from(s);
  return b.length === secretBuf.length && timingSafeEqual(b, secretBuf);
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Mode stateless : un serveur + un transport par requête
app.post("/mcp/:secret", async (req, res) => {
  if (!validSecret(req.params.secret)) {
    res.status(404).end();
    return;
  }
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Erreur MCP :", e instanceof Error ? e.message : e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

app.all("/mcp/:secret", (req, res) => {
  if (!validSecret(req.params.secret)) {
    res.status(404).end();
    return;
  }
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.listen(PORT, HOST, () => {
  console.log(`MCP PRIM prêt sur http://${HOST}:${PORT}/mcp/<MCP_SECRET>`);
});
