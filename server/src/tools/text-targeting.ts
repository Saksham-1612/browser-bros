import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import { textResult, jsonResult } from "./helpers.js";

export function registerTextTargetingTools(server: McpServer, bridge: WebSocketBridge) {
  server.tool(
    "browser_get_interactive_elements",
    "List all interactive elements on the page (buttons, inputs, links, etc.) with their visible text, stable selectors, and ARIA metadata. Much faster than reading raw HTML to find clickable targets. Use the `filter` param to narrow results by text, aria-label, placeholder, or id.",
    {
      filter: z.string().optional().describe("Filter by text, aria-label, placeholder, or id (case-insensitive substring match)"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ filter, tabId }) => {
      const result = await bridge.sendCommand("get_interactive_elements", { filter, tabId });
      return jsonResult(result);
    }
  );

  server.tool(
    "browser_click_by_text",
    "Click an element by its visible text label — the highest-leverage targeting method for SPAs where CSS selectors are unstable (MUI JSS class names, React-generated IDs, etc.). Returns the clicked element's tagName and full text so you can confirm the right element was hit.",
    {
      text: z.string().describe("Visible text to search for (button label, link text, etc.)"),
      exact: z.boolean().optional().default(false).describe("If true, text must match exactly. If false (default), substring match is used."),
      elementType: z.enum(["*", "button", "link"]).optional().default("*").describe("Narrow to a specific element category: 'button' includes <button> and role=button, 'link' is <a> only, '*' searches all elements."),
      waitMs: z.number().optional().default(0).describe("Extra ms to wait after click (useful for SPA route transitions)"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ text, exact, elementType, waitMs, tabId }) => {
      const result = (await bridge.sendCommand("click_by_text", { text, exact, elementType, tabId })) as {
        clicked: boolean; tagName: string; text: string;
      };
      if (waitMs && waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
      return textResult(`Clicked: <${result.tagName}> "${result.text}"`);
    }
  );

  server.tool(
    "browser_type_by_label",
    "Type text into a form field by its label, placeholder, or aria-label — works on MUI/JSS-rendered pages where label linkage via 'for' attribute may be indirect. Falls back through: label[for] → nested input → placeholder → aria-label.",
    {
      label: z.string().describe("Label text, placeholder text, or aria-label of the input field"),
      text: z.string().describe("Text to type into the field"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ label, text, tabId }) => {
      const result = (await bridge.sendCommand("type_by_label", { label, text, tabId })) as {
        typed: boolean; tagName: string; id: string | null;
      };
      return textResult(`Typed into <${result.tagName}>${result.id ? ` #${result.id}` : ""} (matched label "${label}")`);
    }
  );

  server.tool(
    "browser_find_by_xpath",
    "Find and interact with an element using an XPath expression. Supports click, type, and read actions.",
    {
      xpath: z.string().describe("XPath expression to locate the element"),
      action: z.enum(["click", "type", "read"]).optional().default("click").describe("Action to perform: 'click', 'type' (requires text param), or 'read' (returns element text/html)"),
      text: z.string().optional().describe("Text to type (only used when action='type')"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ xpath, action, text, tabId }) => {
      const result = await bridge.sendCommand("find_by_xpath", { xpath, action, text, tabId });
      return jsonResult(result);
    }
  );
}
