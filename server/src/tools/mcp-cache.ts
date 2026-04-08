import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import { 
  getCachedMCPResult, 
  setCachedMCPResult, 
  invalidateMCPCache, 
  getCacheStats,
  getCachedAction,
  saveCachedAction,
  invalidateActionCache,
  getActionCacheStats,
} from "../memory.js";

export function registerMCPCacheTools(server: McpServer, bridge: WebSocketBridge) {
  
  server.tool(
    "mcp_cache_get",
    "Get a cached MCP tool result by tool name and arguments.",
    {
      tool: z.string().describe("Tool name to get cached result for"),
      args: z.string().describe("JSON string of arguments passed to the tool"),
    },
    async ({ tool, args }) => {
      try {
        const parsedArgs = JSON.parse(args || "{}");
        const cached = await getCachedMCPResult(tool, parsedArgs);
        if (cached !== null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ cached: true, result: cached }),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ cached: false }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );

  server.tool(
    "mcp_cache_set",
    "Cache an MCP tool result for future use.",
    {
      tool: z.string().describe("Tool name to cache result for"),
      args: z.string().describe("JSON string of arguments passed to the tool"),
      result: z.string().describe("JSON string of the result to cache"),
    },
    async ({ tool, args, result }) => {
      try {
        const parsedArgs = JSON.parse(args || "{}");
        const parsedResult = JSON.parse(result);
        await setCachedMCPResult(tool, parsedArgs, parsedResult);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );

  server.tool(
    "mcp_cache_invalidate",
    "Invalidate the MCP cache for a specific tool or all tools.",
    {
      tool: z.string().optional().describe("Tool name to invalidate (optional, clears all if not provided)"),
    },
    async ({ tool }) => {
      try {
        await invalidateMCPCache(tool);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, cleared: tool || "all" }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );

  server.tool(
    "mcp_cache_stats",
    "Get statistics about the MCP cache.",
    {},
    async () => {
      try {
        const stats = await getCacheStats();
        const actionStats = await getActionCacheStats();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ mcp: stats, action: actionStats }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );

  server.tool(
    "browser_cache_get",
    "Get cached action (click/type) result for a URL, action, and target.",
    {
      url: z.string().describe("Current page URL"),
      action: z.enum(["click", "type", "fill", "read", "wait", "extract"]).describe("Action type"),
      target: z.string().describe("Target element description"),
    },
    async ({ url, action, target }) => {
      try {
        const cached = await getCachedAction(url, action, target);
        if (cached) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ 
                cached: true, 
                selector: cached.selector,
                selectorType: cached.selectorType,
                successCount: cached.successCount,
                result: cached.result 
              }),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ cached: false }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );

  server.tool(
    "browser_cache_save",
    "Save a successful browser action to cache.",
    {
      url: z.string().describe("Current page URL"),
      action: z.enum(["click", "type", "fill", "read", "wait", "extract"]).describe("Action type"),
      target: z.string().describe("Target element description"),
      selector: z.string().describe("The selector that worked"),
      selectorType: z.enum(["css", "xpath", "text"]).optional().default("css"),
      result: z.string().optional().describe("Result to cache as JSON"),
    },
    async ({ url, action, target, selector, selectorType, result }) => {
      try {
        const parsedResult = result ? JSON.parse(result) : { success: true };
        await saveCachedAction(url, action, target, parsedResult, selector, selectorType);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, selector, selectorType }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );

  server.tool(
    "browser_cache_clear",
    "Clear action cache for a URL or all.",
    {
      url: z.string().optional().describe("URL to clear cache for (optional, clears all if not provided)"),
    },
    async ({ url }) => {
      try {
        await invalidateActionCache(url);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ success: true, cleared: url || "all" }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ error: String(err) }),
          }],
        };
      }
    }
  );
}

export async function checkMCPCache(
  tool: string,
  args: Record<string, unknown>
): Promise<unknown | null> {
  return await getCachedMCPResult(tool, args);
}

export async function updateMCPCache(
  tool: string,
  args: Record<string, unknown>,
  result: unknown
): Promise<void> {
  await setCachedMCPResult(tool, args, result);
}

export { getCachedAction, saveCachedAction };