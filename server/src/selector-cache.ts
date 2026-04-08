import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface SelectorEntry {
  selector: string;
  selectorType: "css" | "xpath" | "text";
  action: "click" | "type" | "fill" | "read" | "wait" | "extract";
  target: string;
  context?: string;
  successCount: number;
  lastUsed: string;
  metadata?: {
    tagName?: string;
    className?: string;
    id?: string;
    attributes?: Record<string, string>;
  };
}

export interface DomainCache {
  domain: string;
  entries: SelectorEntry[];
  lastUpdated: string;
}

export interface SelectorCache {
  version: number;
  domains: Record<string, DomainCache>;
}

const CACHE_VERSION = 1;
const CACHE_DIR = join(homedir(), ".browser-mcp");
const CACHE_FILE = join(CACHE_DIR, "selector-cache.json");

function getDefaultCache(): SelectorCache {
  return {
    version: CACHE_VERSION,
    domains: {},
  };
}

function loadCache(): SelectorCache {
  try {
    if (!existsSync(CACHE_FILE)) {
      return getDefaultCache();
    }
    const data = readFileSync(CACHE_FILE, "utf-8");
    const cache = JSON.parse(data) as SelectorCache;
    if (cache.version !== CACHE_VERSION) {
      return migrateCache(cache);
    }
    return cache;
  } catch {
    return getDefaultCache();
  }
}

function saveCache(cache: SelectorCache): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch (err) {
    process.stderr.write(`[SelectorCache] Failed to save cache: ${(err as Error).message}\n`);
  }
}

function migrateCache(oldCache: SelectorCache): SelectorCache {
  return {
    version: CACHE_VERSION,
    domains: oldCache.domains || {},
  };
}

function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function normalizeTarget(target: string): string {
  return target.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Returns true for selectors that are dynamically generated and will change
 * on every page load — these are not worth caching.
 * Examples: .jss23, .makeStyles-root-47, .css-1x2y3z, :nth-child(3) > div > span
 */
function isUnstableSelector(selector: string): boolean {
  // Dynamic CSS-in-JS class patterns (MUI JSS, emotion, styled-components)
  if (/\.(jss|makeStyles|css-|sc-|emotion-|MuiPrivate)[a-zA-Z0-9_-]*\d/.test(selector)) return true;
  // Pure numeric class names or hash-like classes
  if (/\.[a-z]{1,3}\d{3,}/.test(selector)) return true;
  // Selectors that rely heavily on positional/structural traversal (fragile)
  if ((selector.match(/nth-(child|of-type)/g) || []).length > 1) return true;
  // Selectors with no stable anchor (only tag names and combinators)
  if (/^(div|span|li|ul|p|section|article|main|header|footer|aside)[\s>+~]/.test(selector) && !/[#\[.]/.test(selector)) return true;
  return false;
}

export class SelectorCacheManager {
  private cache: SelectorCache;

  constructor() {
    this.cache = loadCache();
  }

  /**
   * Find cached selectors for a given URL, action, and target
   */
  find(url: string, action: SelectorEntry["action"], target: string): SelectorEntry[] {
    const domain = extractDomain(url);
    const normalizedTarget = normalizeTarget(target);
    const domainCache = this.cache.domains[domain];

    if (!domainCache) {
      return [];
    }

    return domainCache.entries
      .filter((entry) => {
        if (entry.action !== action) return false;
        const entryTarget = normalizeTarget(entry.target);
        return entryTarget === normalizedTarget ||
               entryTarget.includes(normalizedTarget) ||
               normalizedTarget.includes(entryTarget);
      })
      .sort((a, b) => b.successCount - a.successCount);
  }

  /**
   * Find all cached entries for a domain
   */
  findByDomain(url: string): SelectorEntry[] {
    const domain = extractDomain(url);
    const domainCache = this.cache.domains[domain];
    return domainCache ? domainCache.entries : [];
  }

  /**
   * Find selectors by partial target match (useful for searching)
   */
  search(url: string, query: string): SelectorEntry[] {
    const domain = extractDomain(url);
    const normalizedQuery = normalizeTarget(query);
    const domainCache = this.cache.domains[domain];

    if (!domainCache) {
      return [];
    }

    return domainCache.entries
      .filter((entry) => {
        const entryTarget = normalizeTarget(entry.target);
        return entryTarget.includes(normalizedQuery) ||
               (entry.context && normalizeTarget(entry.context).includes(normalizedQuery));
      })
      .sort((a, b) => b.successCount - a.successCount);
  }

  /**
   * Save a successful selector to the cache
   */
  save(
    url: string,
    action: SelectorEntry["action"],
    target: string,
    selector: string,
    selectorType: SelectorEntry["selectorType"] = "css",
    context?: string,
    metadata?: SelectorEntry["metadata"]
  ): void {
    // XPath is always stable — only filter unstable CSS selectors
    if (selectorType !== "xpath" && isUnstableSelector(selector)) return;

    const domain = extractDomain(url);
    const normalizedTarget = normalizeTarget(target);

    if (!this.cache.domains[domain]) {
      this.cache.domains[domain] = {
        domain,
        entries: [],
        lastUpdated: new Date().toISOString(),
      };
    }

    const domainCache = this.cache.domains[domain];
    const existingIndex = domainCache.entries.findIndex(
      (e) => e.action === action && normalizeTarget(e.target) === normalizedTarget
    );

    const entry: SelectorEntry = {
      selector,
      selectorType,
      action,
      target: target.trim(),
      context,
      successCount: 1,
      lastUsed: new Date().toISOString(),
      metadata,
    };

    if (existingIndex >= 0) {
      const existing = domainCache.entries[existingIndex];
      entry.successCount = existing.successCount + 1;
      domainCache.entries[existingIndex] = entry;
    } else {
      domainCache.entries.push(entry);
    }

    domainCache.lastUpdated = new Date().toISOString();
    saveCache(this.cache);
  }

  /**
   * Record a successful use of a selector (increments success count)
   */
  recordSuccess(url: string, action: SelectorEntry["action"], target: string): void {
    const domain = extractDomain(url);
    const normalizedTarget = normalizeTarget(target);
    const domainCache = this.cache.domains[domain];

    if (!domainCache) return;

    const entry = domainCache.entries.find(
      (e) => e.action === action && normalizeTarget(e.target) === normalizedTarget
    );

    if (entry) {
      entry.successCount++;
      entry.lastUsed = new Date().toISOString();
      domainCache.lastUpdated = new Date().toISOString();
      saveCache(this.cache);
    }
  }

  /**
   * Get all cached domains
   */
  getDomains(): string[] {
    return Object.keys(this.cache.domains);
  }

  /**
   * Clear cache for a specific domain
   */
  clearDomain(url: string): void {
    const domain = extractDomain(url);
    delete this.cache.domains[domain];
    saveCache(this.cache);
  }

  /**
   * Clear entire cache
   */
  clearAll(): void {
    this.cache = getDefaultCache();
    saveCache(this.cache);
  }

  /**
   * Get cache statistics
   */
  getStats(): { totalDomains: number; totalEntries: number } {
    const domains = Object.keys(this.cache.domains);
    const entries = domains.reduce(
      (sum, d) => sum + this.cache.domains[d].entries.length,
      0
    );
    return { totalDomains: domains.length, totalEntries: entries };
  }
}

export const selectorCache = new SelectorCacheManager();
