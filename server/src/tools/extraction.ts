import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import { jsonResult } from "./helpers.js";

export function registerExtractionTools(server: McpServer, bridge: WebSocketBridge) {
  server.tool(
    "browser_get_links",
    "Extract all links from the page, optionally filtered.",
    {
      tabId: z.number().optional(),
      filter: z.string().optional().describe("Filter links by URL or text substring"),
    },
    async ({ tabId, filter }) => {
      const result = await bridge.sendCommand("get_links", { tabId, filter });
      return jsonResult(result);
    }
  );

  server.tool(
    "browser_get_elements",
    "Get elements matching a CSS selector with their attributes.",
    {
      selector: z.string().describe("CSS selector"),
      attributes: z.array(z.string()).optional().default(["textContent", "href", "src", "alt", "value", "class", "id"]),
      limit: z.number().optional().default(50).describe("Max elements to return"),
      maxTextLength: z.number().optional().default(300).describe("Max characters for textContent/innerText fields (default 300)"),
      includeInnerText: z.boolean().optional().default(false).describe("Also include innerText (rendered visible text only, no hidden child noise) alongside textContent"),
      tabId: z.number().optional(),
    },
    async ({ selector, attributes, limit, maxTextLength, includeInnerText, tabId }) => {
      const result = await bridge.sendCommand("get_elements", { selector, attributes, limit, maxTextLength, includeInnerText, tabId });
      return jsonResult(result);
    }
  );

  server.tool(
    "browser_extract_table",
    "Extract table data as structured JSON (headers + rows).",
    {
      selector: z.string().optional().default("table").describe("CSS selector for the table"),
      tabId: z.number().optional(),
    },
    async ({ selector, tabId }) => {
      const result = await bridge.sendCommand("extract_table", { selector, tabId });
      return jsonResult(result);
    }
  );

  server.tool(
    "browser_get_cookies",
    "Get cookies for a specific URL.",
    {
      url: z.string().url().describe("URL to get cookies for"),
    },
    async ({ url }) => {
      const result = await bridge.sendCommand("get_cookies", { url });
      return jsonResult(result);
    }
  );

  server.tool(
    "browser_get_storage",
    "Read localStorage or sessionStorage entries.",
    {
      type: z.enum(["localStorage", "sessionStorage"]),
      key: z.string().optional().describe("Specific key. If omitted, returns all entries."),
      tabId: z.number().optional(),
    },
    async ({ type, key, tabId }) => {
      const result = await bridge.sendCommand("get_storage", { type, key, tabId });
      return jsonResult(result);
    }
  );
}
