import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import { selectorCache, type SelectorEntry } from "../selector-cache.js";
import { jsonResult, textResult } from "./helpers.js";

export function registerCacheTools(server: McpServer, bridge: WebSocketBridge) {
  server.tool(
    "browser_cache_find_selector",
    "Query the selector cache to find previously working selectors for the current page. ALWAYS call this first before browser_inspect_page or any guessing — if a cached selector exists, use it directly and skip page inspection entirely. Returns cached selectors sorted by reliability (success count).",
    {
      url: z.string().describe("Current page URL to look up selectors for"),
      action: z.enum(["click", "type", "fill", "read", "wait", "extract"]).describe("The action you want to perform"),
      target: z.string().describe("Description of the target element (e.g., 'Submit button', 'Email input', 'Login form')"),
    },
    async ({ url, action, target }) => {
      const entries = selectorCache.find(url, action, target);
      
      if (entries.length === 0) {
        return textResult(`No cached selectors found for "${target}" (${action}) on ${new URL(url).hostname}`);
      }

      const formatted = entries.map((e, i) => formatEntry(e, i + 1));
      return textResult(
        `Found ${entries.length} cached selector(s) for "${target}" (${action}):\n\n${formatted.join("\n\n")}`
      );
    }
  );

  server.tool(
    "browser_cache_search",
    "Search the selector cache by partial match. Useful when you're not sure of the exact target name.",
    {
      url: z.string().describe("Current page URL"),
      query: z.string().describe("Search query (partial match on target name or context)"),
    },
    async ({ url, query }) => {
      const entries = selectorCache.search(url, query);
      
      if (entries.length === 0) {
        return textResult(`No cached selectors found matching "${query}" on ${new URL(url).hostname}`);
      }

      const formatted = entries.map((e, i) => formatEntry(e, i + 1));
      return textResult(
        `Found ${entries.length} cached selector(s) matching "${query}":\n\n${formatted.join("\n\n")}`
      );
    }
  );

  server.tool(
    "browser_cache_save_selector",
    "Save a working selector to the cache for future use. Call this after successfully using a selector so it can be reused next time.",
    {
      url: z.string().describe("Current page URL"),
      action: z.enum(["click", "type", "fill", "read", "wait", "extract"]).describe("The action performed"),
      target: z.string().describe("Human-readable description of what this selector targets (e.g., 'Submit button', 'Email input')"),
      selector: z.string().describe("The CSS selector, XPath, or text matcher that worked"),
      selectorType: z.enum(["css", "xpath", "text"]).optional().default("css").describe("Type of selector"),
      context: z.string().optional().describe("Additional context (e.g., 'Login form', 'Header navigation')"),
    },
    async ({ url, action, target, selector, selectorType, context }) => {
      selectorCache.save(url, action, target, selector, selectorType, context);
      return textResult(`✓ Cached ${selectorType} selector for "${target}" (${action}) on ${new URL(url).hostname}`);
    }
  );

  server.tool(
    "browser_cache_list_domain",
    "List all cached selectors for a specific domain.",
    {
      url: z.string().describe("Any URL from the domain to list"),
    },
    async ({ url }) => {
      const entries = selectorCache.findByDomain(url);
      
      if (entries.length === 0) {
        const domain = new URL(url).hostname;
        return textResult(`No cached selectors for domain: ${domain}`);
      }

      const byAction = groupByAction(entries);
      const lines: string[] = [];
      
      for (const [action, actionEntries] of Object.entries(byAction)) {
        lines.push(`\n[${action.toUpperCase()}]`);
        actionEntries.forEach((e, i) => {
          lines.push(formatEntry(e, i + 1));
        });
      }

      return textResult(`Cached selectors for ${new URL(url).hostname}:${lines.join("\n")}`);
    }
  );

  server.tool(
    "browser_cache_stats",
    "Get statistics about the selector cache.",
    {},
    async () => {
      const stats = selectorCache.getStats();
      const domains = selectorCache.getDomains();
      
      return jsonResult({
        totalDomains: stats.totalDomains,
        totalEntries: stats.totalEntries,
        domains: domains,
        cacheLocation: "~/.browser-mcp/selector-cache.json",
      });
    }
  );

  server.tool(
    "browser_cache_clear",
    "Clear the selector cache for a domain or entirely.",
    {
      url: z.string().optional().describe("URL of domain to clear. If omitted, clears entire cache."),
    },
    async ({ url }) => {
      if (url) {
        const domain = new URL(url).hostname;
        selectorCache.clearDomain(url);
        return textResult(`Cleared cache for domain: ${domain}`);
      } else {
        selectorCache.clearAll();
        return textResult("Cleared entire selector cache");
      }
    }
  );
}

function formatEntry(entry: SelectorEntry, index: number): string {
  const reliability = entry.successCount >= 5 ? "★★★" : entry.successCount >= 2 ? "★★☆" : "★☆☆";
  const lines = [
    `${index}. ${reliability} "${entry.target}"`,
    `   Selector: ${entry.selectorType} → ${entry.selector}`,
  ];
  
  if (entry.context) {
    lines.push(`   Context: ${entry.context}`);
  }
  
  lines.push(`   Used ${entry.successCount} time(s), last: ${new Date(entry.lastUsed).toLocaleDateString()}`);
  
  if (entry.metadata) {
    const meta = Object.entries(entry.metadata)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (meta) lines.push(`   Meta: ${meta}`);
  }
  
  return lines.join("\n");
}

function groupByAction(entries: SelectorEntry[]): Record<string, SelectorEntry[]> {
  return entries.reduce((acc, entry) => {
    if (!acc[entry.action]) acc[entry.action] = [];
    acc[entry.action].push(entry);
    return acc;
  }, {} as Record<string, SelectorEntry[]>);
}
