import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./createMcpServer.js";
import { logError, logSuccess } from "../logger.js";

/**
 * Monta o endpoint MCP Streamable HTTP em /mcp (POST/GET/DELETE).
 * Sem autenticação (fase de testes). Adequado a 1 instância no Railway.
 *
 * @param {import("express").Express} app
 * @param {{ executeSearchByText: Function, getPublicConfig: Function }} deps
 */
export function mountMcp(app, deps) {
  const transports = Object.create(null);

  const mcpPostHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];

    try {
      let transport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            logSuccess("MCP", "Sessão inicializada", { session_id: sid });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            logSuccess("MCP", "Sessão encerrada", { session_id: sid });
          }
        };

        const server = createMcpServer(deps);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logError("MCP", "Erro no POST /mcp", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      logError("MCP", "Erro no GET /mcp", error);
      if (!res.headersSent) res.status(500).send("Internal server error");
    }
  };

  const mcpDeleteHandler = async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    try {
      await transports[sessionId].handleRequest(req, res);
    } catch (error) {
      logError("MCP", "Erro no DELETE /mcp", error);
      if (!res.headersSent) res.status(500).send("Error processing session termination");
    }
  };

  app.post("/mcp", mcpPostHandler);
  app.get("/mcp", mcpGetHandler);
  app.delete("/mcp", mcpDeleteHandler);

  return {
    closeAll: async () => {
      for (const sid of Object.keys(transports)) {
        try {
          await transports[sid].close();
        } catch {
          /* ignore */
        }
        delete transports[sid];
      }
    },
  };
}
