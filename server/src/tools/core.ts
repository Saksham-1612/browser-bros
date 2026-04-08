import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import type { PageContent, TabInfo } from "../types.js";
import { truncate, textResult } from "./helpers.js";
import { selectorCache } from "../selector-cache.js";

export function registerCoreTools(server: McpServer, bridge: WebSocketBridge) {
  server.tool(
    "browser_navigate",
    "Navigate to a URL in the browser and return page content. Uses the user's logged-in browser session, bypassing 403/auth issues.",
    {
      url: z.string().url().describe("The URL to navigate to"),
      waitMs: z.number().optional().default(1000).describe("Extra ms to wait after page load for SPA rendering"),
    },
    async ({ url, waitMs }) => {
      const result = (await bridge.sendCommand("navigate", { url, waitMs })) as PageContent;
      const cachedEntries = selectorCache.findByDomain(result.url);
      let cacheHint = "";
      if (cachedEntries.length > 0) {
        const lines = cachedEntries
          .slice(0, 20)
          .map(e => `  [${e.action}] "${e.target}" → ${e.selector}  (used ${e.successCount}x)`);
        cacheHint = `\n\n⚡ CACHED SELECTORS — use browser_act with the target name to reuse these instantly:\n${lines.join("\n")}\n  Example: browser_act({ action: "click", target: "Login" }) — DO NOT re-inspect the page.`;
      }
      return textResult(`Title: ${result.title}\nURL: ${result.url}\n\n${truncate(result.text)}${cacheHint}`);
    }
  );

  server.tool(
    "browser_read_page",
    "Read content from the current active tab or a specific tab.",
    {
      tabId: z.number().optional().describe("Tab ID to read from. If omitted, reads active tab."),
      format: z.enum(["text", "html", "full"]).optional().default("text").describe("Content format"),
    },
    async ({ tabId, format }) => {
      const result = (await bridge.sendCommand("read_page", { tabId, format })) as PageContent;
      if (format === "html") {
        return textResult(truncate(result.html ?? "", 200_000));
      }
      if (format === "full") {
        const meta = result.meta
          ? Object.entries(result.meta).map(([k, v]) => `${k}: ${v}`).join("\n")
          : "";
        return textResult(`Title: ${result.title}\nURL: ${result.url}\n\nMeta:\n${meta}\n\nText:\n${truncate(result.text)}\n\nHTML:\n${truncate(result.html ?? "", 200_000)}`);
      }
      return textResult(`Title: ${result.title}\nURL: ${result.url}\n\n${truncate(result.text)}`);
    }
  );

  server.tool(
    "browser_list_tabs",
    "List all open browser tabs with their IDs, URLs, and titles.",
    {},
    async () => {
      const tabs = (await bridge.sendCommand("list_tabs")) as TabInfo[];
      const lines = tabs.map(
        (t) => `[${t.id}] ${t.active ? "(active) " : ""}${t.title}\n    ${t.url}`
      );
      return textResult(lines.join("\n\n") || "No tabs open.");
    }
  );

  server.tool(
    "browser_close_tab",
    "Close a specific browser tab by its ID.",
    { tabId: z.number().describe("The ID of the tab to close") },
    async ({ tabId }) => {
      await bridge.sendCommand("close_tab", { tabId });
      return textResult(`Tab ${tabId} closed.`);
    }
  );

  server.tool(
    "browser_click",
    "Click an element by CSS selector. WARNING: CSS selectors fail on React/MUI apps with dynamic class names (jss23, makeStyles, etc). ALWAYS prefer browser_act instead — it uses XPath text matching which is immune to dynamic classes. Only use browser_click when you have a stable selector like #id, [name=x], or [data-testid=x].",
    {
      selector: z.string().describe("CSS selector of the element to click"),
      waitMs: z.number().optional().default(0).describe("Extra ms to wait after click for SPA route transitions or animations"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
      waitForSelector: z.string().optional().describe("CSS selector to wait for after click (useful for SPA step transitions)"),
      waitForSelectorTimeout: z.number().optional().default(5000).describe("Timeout in ms for waitForSelector (default 5000)"),
    },
    async ({ selector, waitMs, tabId, waitForSelector, waitForSelectorTimeout }) => {
      const result = (await bridge.sendCommand("click", { selector, tabId, waitForSelector, waitForSelectorTimeout })) as {
        clicked: boolean; tagName: string; text: string; wasVisible: boolean;
      } | boolean;
      if (waitMs && waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      
      // Check if this selector came from cache (for feedback) — checks across all cached domains
      const fromCache = selectorCache.getDomains().some(d =>
        selectorCache.findByDomain(`https://${d}`).some(e => e.selector === selector)
      );

      // Auto-cache successful selector (fire-and-forget — does not block click response)
      if (result && typeof result === "object" && "tagName" in result && result.clicked) {
        const clickedResult = result;
        bridge.sendCommand("read_page", { tabId, format: "text" }).then((pageInfo) => {
          const target = (clickedResult.text as string)?.trim() || selector;
          selectorCache.save((pageInfo as PageContent).url, "click", target, selector, "css", undefined, {
            tagName: clickedResult.tagName as string,
          });
        }).catch(() => {});
        const cacheTag = fromCache ? " [⚡ from cache]" : " [learned]";
        return textResult(`Clicked: <${result.tagName}> "${result.text}"${result.wasVisible ? "" : " (was not visible)"}${cacheTag}`);
      }
      return textResult(`Clicked element: ${selector}`);
    }
  );

  server.tool(
    "browser_type",
    "Type text into a field by CSS selector. WARNING: CSS selectors fail on React/MUI apps with dynamic class names. ALWAYS prefer browser_act instead — it uses label/XPath matching that works on any SPA. Only use browser_type when you have a stable selector like #id or [name=x].",
    {
      selector: z.string().describe("CSS selector of the input element"),
      text: z.string().describe("Text to type into the field"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ selector, text, tabId }) => {
      await bridge.sendCommand("type", { selector, text, tabId });
      
      // Auto-cache successful selector (fire-and-forget — does not block type response)
      bridge.sendCommand("read_page", { tabId, format: "text" }).then((pageInfo) => {
        const match = selector.match(/(?:name|id|placeholder)=['"]?([^'"=\]]+)/i);
        const target = match?.[1] || selector.replace(/[#.\[\]"='*]/g, " ").trim() || "input";
        selectorCache.save((pageInfo as PageContent).url, "type", target, selector, "css");
      }).catch(() => {});
      
      return textResult(`Typed "${text}" into ${selector}`);
    }
  );

  server.tool(
    "browser_screenshot",
    "Take a screenshot of the current browser tab. Returns a base64-encoded PNG image.",
    { tabId: z.number().optional().describe("Tab ID. If omitted, screenshots active tab.") },
    async ({ tabId }) => {
      const result = (await bridge.sendCommand("screenshot", { tabId })) as string;
      const base64 = result.replace(/^data:image\/png;base64,/, "");
      return {
        content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
      };
    }
  );

  server.tool(
    "browser_execute_js",
    "Execute JavaScript in the page. DO NOT use this to click or type — browser_act handles all interactions with XPath text matching and proper React event dispatching. Use browser_execute_js only for reading computed values, checking state, or operations that have no dedicated tool.",
    {
      code: z.string().describe("JavaScript code to execute in the page context"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ code, tabId }) => {
      const result = await bridge.sendCommand("execute_js", { code, tabId });
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return textResult(truncate(text));
    }
  );
}
