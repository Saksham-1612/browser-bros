import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import { textResult } from "./helpers.js";

const FormFieldSchema = z.object({
  selector: z.string().optional().describe("CSS selector for the field (e.g. '#email', 'input[name=phone]')"),
  label: z.string().optional().describe("Label text, placeholder, aria-label, or name to find the field by"),
  value: z.string().describe("Value to fill into the field"),
});

export function registerInteractionTools(server: McpServer, bridge: WebSocketBridge) {
  server.tool(
    "browser_fill_form",
    "Fill multiple form fields at once in a single operation. Each field can be identified by CSS selector or label text. Supports text inputs, textareas, selects, checkboxes, and radio buttons. Much faster than calling browser_type for each field individually.",
    {
      fields: z.array(FormFieldSchema).min(1).describe(
        "Array of fields to fill. Each entry needs either 'selector' (CSS selector) or 'label' (label text/placeholder/aria-label), plus 'value'."
      ),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ fields, tabId }) => {
      const results = (await bridge.sendCommand("fill_form", { fields, tabId })) as Array<{
        field: string; filled?: boolean; type?: string; error?: string; checked?: boolean; selectedText?: string; strategy?: string;
      }>;
      const lines = results.map((r) => {
        const via = r.strategy ? ` [via ${r.strategy}]` : "";
        if (r.error) return `✗ ${r.field}: ${r.error}`;
        if (r.type === "select") return `✓ ${r.field}${via}: selected "${r.selectedText}"`;
        if (r.type === "checkbox" || r.type === "radio") return `✓ ${r.field}${via}: ${r.checked ? "checked" : "unchecked"}`;
        return `✓ ${r.field}${via}: filled`;
      });
      const failed = results.filter((r) => r.error).length;
      const summary = `Filled ${results.length - failed}/${results.length} fields` + (failed ? ` (${failed} failed)` : "");
      return textResult(`${summary}\n\n${lines.join("\n")}`);
    }
  );

  server.tool(
    "browser_batch",
    "Execute multiple browser actions sequentially in a single command. Useful for automating multi-step workflows (click → wait → type → click). Each action specifies a 'command' (any browser_ tool name without the 'browser_' prefix) and its 'params'.",
    {
      actions: z.array(
        z.object({
          command: z.string().describe("Browser command to run (e.g. 'click', 'type', 'navigate', 'scroll')"),
          params: z.record(z.unknown()).optional().default({}).describe("Parameters for the command"),
          abortOnError: z.boolean().optional().default(false).describe("Stop the batch if this step fails"),
        })
      ).min(1).describe("List of actions to execute in order"),
      tabId: z.number().optional().describe("Default tab ID for all steps. Individual steps can override with their own tabId."),
    },
    async ({ actions, tabId }) => {
      const results = (await bridge.sendCommand("batch", { actions, tabId })) as Array<{
        command: string; result?: unknown; error?: string;
      }>;
      const lines = results.map((r, i) => {
        const prefix = `[${i + 1}] ${r.command}:`;
        if (r.error) return `✗ ${prefix} ${r.error}`;
        const summary = typeof r.result === "object" ? JSON.stringify(r.result).slice(0, 120) : String(r.result ?? "ok");
        return `✓ ${prefix} ${summary}`;
      });
      const failed = results.filter((r) => r.error).length;
      const summary = `Completed ${results.length - failed}/${results.length} steps` + (failed ? ` (${failed} failed)` : "");
      return textResult(`${summary}\n\n${lines.join("\n")}`);
    }
  );


  server.tool(
    "browser_right_click",
    "Right-click (context menu) on an element by CSS selector.",
    {
      selector: z.string().describe("CSS selector of the element"),
      tabId: z.number().optional(),
    },
    async ({ selector, tabId }) => {
      await bridge.sendCommand("right_click", { selector, tabId });
      return textResult(`Right-clicked: ${selector}`);
    }
  );

  server.tool(
    "browser_double_click",
    "Double-click on an element by CSS selector.",
    {
      selector: z.string().describe("CSS selector of the element"),
      tabId: z.number().optional(),
    },
    async ({ selector, tabId }) => {
      await bridge.sendCommand("double_click", { selector, tabId });
      return textResult(`Double-clicked: ${selector}`);
    }
  );

  server.tool(
    "browser_drag_drop",
    "Drag an element and drop it onto another element.",
    {
      fromSelector: z.string().describe("CSS selector of the draggable element"),
      toSelector: z.string().describe("CSS selector of the drop target"),
      tabId: z.number().optional(),
    },
    async ({ fromSelector, toSelector, tabId }) => {
      await bridge.sendCommand("drag_drop", { fromSelector, toSelector, tabId });
      return textResult(`Dragged ${fromSelector} → ${toSelector}`);
    }
  );
}
