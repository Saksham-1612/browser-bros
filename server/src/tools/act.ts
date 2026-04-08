import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WebSocketBridge } from "../ws-bridge.js";
import type { PageContent } from "../types.js";
import { textResult } from "./helpers.js";
import { getCachedAction, saveCachedAction } from "./mcp-cache.js";

/**
 * Generate XPath expressions to try for a given target text.
 * XPath is preferred over CSS because it matches on visible text content —
 * stable across React re-renders, immune to dynamic JSS class names.
 */
function xpathsForTarget(target: string): string[] {
  const t = target.replace(/"/g, "'"); // escape for XPath string
  return [
    // Exact text match on clickable elements
    `//*[self::button or self::a or @role='button' or @role='tab' or @role='menuitem'][normalize-space(.)="${t}"]`,
    // Contains match on clickable elements
    `//*[self::button or self::a or @role='button' or @role='tab' or @role='menuitem'][contains(normalize-space(.),"${t}")]`,
    // Input by label/placeholder/aria-label
    `//input[@placeholder="${t}" or @aria-label="${t}" or @name="${t}" or @id="${t}"]`,
    `//textarea[@placeholder="${t}" or @aria-label="${t}" or @name="${t}"]`,
    // Label → input linkage
    `//label[contains(normalize-space(.),"${t}")]//input`,
    `//label[contains(normalize-space(.),"${t}")]//textarea`,
    // Partial text on any interactive element
    `//*[@role='button' or self::button][contains(normalize-space(.),"${t}")]`,
    // span/div acting as button
    `//*[contains(@class,'btn') or contains(@class,'button')][contains(normalize-space(.),"${t}")]`,
  ];
}

export function registerActTool(server: McpServer, bridge: WebSocketBridge) {
  server.tool(
    "browser_act",
    `PREFERRED tool for clicking and typing. Takes a human description — no selector needed.
Priority order (fastest to slowest):
  1. Cached XPath/selector (instant, from previous session)
  2. XPath text match (fast, React-safe, immune to dynamic CSS classes)
  3. Label/text CSS match
  4. get_elements with full text scan (thorough fallback)
  5. inspect_page (last resort)

Use this for ALL click/type actions instead of browser_click + browser_inspect_page.

Examples:
  { action: "click", target: "Login" }
  { action: "click", target: "Create Agent" }
  { action: "type",  target: "Email", value: "user@example.com" }
  { action: "type",  target: "Password", value: "secret" }`,
    {
      action: z.enum(["click", "type"]).describe("Action to perform"),
      target: z.string().describe("Visible label, button text, placeholder, aria-label, or field name"),
      value: z.string().optional().describe("Text to type (required when action=type)"),
      waitMs: z.number().optional().default(0).describe("Extra ms to wait after action for SPA transitions"),
      tabId: z.number().optional().describe("Tab ID. If omitted, uses active tab."),
    },
    async ({ action, target, value, waitMs, tabId }) => {
      const errors: string[] = [];
      const wait = () => waitMs ? new Promise(r => setTimeout(r, waitMs)) : Promise.resolve();

      // ── 1. Try cached action from new cache system ────────────────
      try {
        const pageInfo = await bridge.sendCommand("read_page", { tabId, format: "text" }) as PageContent;
        const cached = await getCachedAction(pageInfo.url, action, target);
        
        if (cached && cached.selector) {
          try {
            const command = cached.selectorType === "xpath" ? "find_by_xpath" : "click";
            if (action === "click") {
              const r = cached.selectorType === "xpath"
                ? await bridge.sendCommand("find_by_xpath", { xpath: cached.selector, action: "click", tabId }) as { action?: string }
                : await bridge.sendCommand("click", { selector: cached.selector, tabId }) as { clicked?: boolean };
              const ok = cached.selectorType === "xpath" ? (r as any).action === "clicked" : (r as any).clicked;
              if (ok) {
                await wait();
                await saveCachedAction(pageInfo.url, "click", target, { clicked: true }, cached.selector, cached.selectorType);
                return textResult(`✓ Clicked "${target}" [⚡ cached ${cached.selectorType}: ${cached.selector}]`);
              }
            } else {
              if (cached.selectorType === "xpath") {
                await bridge.sendCommand("find_by_xpath", { xpath: cached.selector, action: "type", text: value ?? "", tabId });
              } else {
                await bridge.sendCommand("type", { selector: cached.selector, text: value ?? "", tabId });
              }
              await wait();
              await saveCachedAction(pageInfo.url, "type", target, { typed: true }, cached.selector, cached.selectorType);
              return textResult(`✓ Typed into "${target}" [⚡ cached ${cached.selectorType}: ${cached.selector}]`);
            }
          } catch (e) {
            errors.push(`cache(${cached.selector}): ${(e as Error).message}`);
          }
        }
      } catch { /* no cache, fall through */ }

      // ── 2. XPath text match (React-safe, no CSS class dependency) ────────
      for (const xpath of xpathsForTarget(target)) {
        try {
          if (action === "click") {
            const r = await bridge.sendCommand("find_by_xpath", { xpath, action: "click", tabId }) as { action?: string; tagName?: string; text?: string };
            if (r?.action === "clicked") {
              await wait();
              // Cache the working xpath for next time
              bridge.sendCommand("read_page", { tabId, format: "text" }).then(p => {
                saveCachedAction((p as PageContent).url, "click", target, { clicked: true }, xpath, "xpath").catch(() => {});
              }).catch(() => {});
              return textResult(`✓ Clicked "${target}" [xpath: ${xpath}]`);
            }
          } else {
            const inputXpaths = xpathsForTarget(target).filter(x => x.includes("input") || x.includes("textarea") || x.includes("label"));
            const xp = xpath.includes("input") || xpath.includes("textarea") || xpath.includes("label") ? xpath : inputXpaths[0];
            if (!xp) continue;
            await bridge.sendCommand("find_by_xpath", { xpath: xp, action: "type", text: value ?? "", tabId });
            await wait();
            bridge.sendCommand("read_page", { tabId, format: "text" }).then(p => {
              saveCachedAction((p as PageContent).url, "type", target, { typed: true }, xp, "xpath").catch(() => {});
            }).catch(() => {});
            return textResult(`✓ Typed into "${target}" [xpath: ${xp}]`);
          }
        } catch (e) {
          errors.push(`xpath: ${(e as Error).message}`);
          break; // one xpath error means element likely not found — try next strategy
        }
      }

      // ── 3. Text / label CSS match ─────────────────────────────────────────
      try {
        if (action === "click") {
          const r = await bridge.sendCommand("click_by_text", { text: target, tabId }) as { clicked: boolean; tagName: string; text: string };
          if (r?.clicked) {
            await wait();
            return textResult(`✓ Clicked "${target}" [text match: <${r.tagName}> "${r.text}"]`);
          }
        } else {
          await bridge.sendCommand("type_by_label", { label: target, text: value ?? "", tabId });
          await wait();
          return textResult(`✓ Typed into "${target}" [label match]`);
        }
      } catch (e) {
        errors.push(`text-match: ${(e as Error).message}`);
      }

      // ── 4. get_elements full text scan ────────────────────────────────────
      try {
        const elements = await bridge.sendCommand("get_elements", {
          selector: 'button,[role="button"],a,input,textarea,select,[role="tab"],[role="menuitem"]',
          attributes: ["textContent", "value", "placeholder", "aria-label", "name", "id", "type"],
          includeInnerText: true,
          limit: 100,
          tabId,
        }) as Array<{ tagName: string; textContent?: string; innerText?: string; placeholder?: string; "aria-label"?: string; name?: string; id?: string }>;

        const tl = target.toLowerCase();
        const match = elements.find(el => {
          const texts = [el.innerText, el.textContent, el["aria-label"], el.placeholder, el.name, el.id]
            .map(v => (v ?? "").toLowerCase());
          return texts.some(t => t.includes(tl) || tl.includes(t.replace(/\s+/g, " ").trim()));
        });

        if (match) {
          // Build a stable xpath for the matched element
          const label = match.innerText || match.textContent || match["aria-label"] || match.placeholder || "";
          const xpath = match.id
            ? `//*[@id="${match.id}"]`
            : `//${match.tagName.toLowerCase()}[contains(normalize-space(.),"${label.trim().slice(0, 50).replace(/"/g, "'")}")]`;

          if (action === "click") {
            const r = await bridge.sendCommand("find_by_xpath", { xpath, action: "click", tabId }) as { action?: string };
            if (r?.action === "clicked") {
              await wait();
              bridge.sendCommand("read_page", { tabId, format: "text" }).then(p => {
                saveCachedAction((p as PageContent).url, "click", target, { clicked: true }, xpath, "xpath").catch(() => {});
              }).catch(() => {});
              return textResult(`✓ Clicked "${target}" [get_elements scan → xpath: ${xpath}]`);
            }
          } else {
            await bridge.sendCommand("find_by_xpath", { xpath, action: "type", text: value ?? "", tabId });
            await wait();
            bridge.sendCommand("read_page", { tabId, format: "text" }).then(p => {
              saveCachedAction((p as PageContent).url, "type", target, { typed: true }, xpath, "xpath").catch(() => {});
            }).catch(() => {});
            return textResult(`✓ Typed into "${target}" [get_elements scan → xpath: ${xpath}]`);
          }
        }
      } catch (e) {
        errors.push(`get_elements: ${(e as Error).message}`);
      }

      // ── 5. inspect_page last resort ───────────────────────────────────────
      try {
        const inspectResult = await bridge.sendCommand("inspect_page", { tabId }) as {
          forms?: Array<{ elements?: Array<{ label?: string; text?: string; selector?: string; actionHint?: string }> }>;
          topLevelElements?: Array<{ label?: string; text?: string; selector?: string; actionHint?: string }>;
        };
        const allEls = [
          ...(inspectResult.topLevelElements ?? []),
          ...(inspectResult.forms ?? []).flatMap(f => f.elements ?? []),
        ];
        const tl = target.toLowerCase();
        const match = allEls.find(el => {
          const label = (el.label ?? "").toLowerCase();
          const text = (el.text ?? "").toLowerCase();
          return label.includes(tl) || tl.includes(label) || text.includes(tl) || tl.includes(text);
        });
        if (match?.selector) {
          const sel = match.selector;
          if (action === "click") {
            await bridge.sendCommand("click", { selector: sel, tabId });
            await wait();
          } else {
            await bridge.sendCommand("type", { selector: sel, text: value ?? "", tabId });
            await wait();
          }
          return textResult(`✓ ${action === "click" ? "Clicked" : "Typed into"} "${target}" [inspect fallback: ${sel}]`);
        }
      } catch (e) {
        errors.push(`inspect: ${(e as Error).message}`);
      }

      return textResult(`✗ Could not ${action} "${target}". Attempts:\n${errors.map(e => `  • ${e}`).join("\n")}`);
    }
  );
}
