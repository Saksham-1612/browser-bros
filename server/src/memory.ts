import { MongoClient, Collection, Db } from 'mongodb';
import { LRUCache } from 'lru-cache';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  _id?: string;
  sessionId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface ActionCacheEntry {
  _id?: string;
  action: string;
  target: string;
  url: string;
  result: unknown;
  selector?: string;
  selectorType?: string;
  timestamp: number;
  successCount: number;
}

export interface MCPCacheEntry {
  key: string;
  result: unknown;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

let mongoClient: MongoClient | null = null;
let db: Db | null = null;
let conversations: Collection<Conversation> | null = null;
let mcpCache: Collection<MCPCacheEntry> | null = null;
let actionCache: Collection<ActionCacheEntry> | null = null;

const mcpResultCache = new LRUCache({
  max: 500,
  ttl: 1000 * 60 * 30,
});

const actionResultCache = new LRUCache<string, ActionCacheEntry>({
  max: 1000,
  ttl: 1000 * 60 * 60 * 24,
});

export async function initMongoDB(uri?: string): Promise<void> {
  const mongoUri = uri || process.env.MONGODB_URI || 'mongodb://localhost:27017';
  mongoClient = new MongoClient(mongoUri);
  await mongoClient.connect();
  db = mongoClient.db('browser-mcp');
  
  conversations = db.collection<Conversation>('conversations');
  mcpCache = db.collection<MCPCacheEntry>('mcp-cache');
  actionCache = db.collection<ActionCacheEntry>('action-cache');
  
  await conversations.createIndex({ sessionId: 1 }, { unique: true });
  await conversations.createIndex({ updatedAt: -1 });
  await mcpCache.createIndex({ key: 1 }, { unique: true });
  await mcpCache.createIndex({ timestamp: 1 }, { expireAfterSeconds: 86400 });
  
  // Action cache indexes
  await actionCache.createIndex({ url: 1, action: 1, target: 1 }, { unique: true });
  await actionCache.createIndex({ timestamp: 1 }, { expireAfterSeconds: 86400 * 30 });
  await actionCache.createIndex({ successCount: -1 });
  
  console.log('[MongoDB] Connected and indexed');
}

export async function closeMongoDB(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    db = null;
    conversations = null;
    mcpCache = null;
  }
}

export async function saveConversation(
  sessionId: string,
  messages: ChatMessage[]
): Promise<void> {
  if (!conversations) return;
  
  const now = Date.now();
  await conversations.updateOne(
    { sessionId },
    {
      $set: {
        sessionId,
        messages,
        updatedAt: now,
      },
      $setOnInsert: {
        createdAt: now,
      },
    },
    { upsert: true }
  );
}

export async function loadConversation(
  sessionId: string
): Promise<ChatMessage[]> {
  if (!conversations) return [];
  
  const conv = await conversations.findOne({ sessionId });
  return conv?.messages || [];
}

export async function clearConversation(sessionId: string): Promise<void> {
  if (!conversations) return;
  await conversations.deleteOne({ sessionId });
}

function generateCacheKey(tool: string, args: Record<string, unknown>): string {
  return `${tool}:${JSON.stringify(args)}`;
}

export async function getCachedMCPResult(
  tool: string,
  args: Record<string, unknown>
): Promise<unknown | null> {
  const cacheKey = generateCacheKey(tool, args);
  
  const memCached = mcpResultCache.get(cacheKey);
  if (memCached !== undefined) {
    return memCached;
  }
  
  if (!mcpCache) return null;
  
  const entry = await mcpCache.findOne({ key: cacheKey });
  if (entry) {
    mcpResultCache.set(cacheKey, entry.result as string & unknown);
    return entry.result;
  }
  
  return null;
}

export async function setCachedMCPResult(
  tool: string,
  args: Record<string, unknown>,
  result: unknown
): Promise<void> {
  const cacheKey = generateCacheKey(tool, args);
  
  mcpResultCache.set(cacheKey, result as string & unknown);
  
  if (!mcpCache) return;
  
  await mcpCache.updateOne(
    { key: cacheKey },
    {
      $set: {
        key: cacheKey,
        result,
        timestamp: Date.now(),
      },
    },
    { upsert: true }
  );
}

export async function invalidateMCPCache(tool?: string): Promise<void> {
  mcpResultCache.clear();
  
  if (!mcpCache) return;
  
  if (tool) {
    await mcpCache.deleteMany({ key: { $regex: `^${tool}:` } });
  } else {
    await mcpCache.deleteMany({});
  }
}

export async function getCacheStats(): Promise<{
  memorySize: number;
  mongoSize: number;
}> {
  const memorySize = mcpResultCache.size;
  
  let mongoSize = 0;
  if (mcpCache) {
    mongoSize = await mcpCache.countDocuments();
  }
  
  return { memorySize, mongoSize };
}

// Action Cache - stores successful browser actions with selectors
export async function getCachedAction(
  url: string,
  action: string,
  target: string
): Promise<ActionCacheEntry | null> {
  const cacheKey = `${url}:${action}:${target}`;
  
  // Check memory cache first
  const memCached = actionResultCache.get(cacheKey);
  if (memCached) {
    return memCached;
  }
  
  if (!actionCache) return null;
  
  // Get domain from URL for matching
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch {}
  
  // Find cached action - match by domain or exact URL
  const entry = await actionCache.find({
    $or: [
      { url: url, action, target },
      { url: { $regex: domain }, action, target }
    ]
  }).sort({ successCount: -1 }).limit(1).toArray();
  
  if (entry.length > 0) {
    actionResultCache.set(cacheKey, entry[0]);
    return entry[0];
  }
  
  return null;
}

export async function saveCachedAction(
  url: string,
  action: string,
  target: string,
  result: unknown,
  selector?: string,
  selectorType?: string
): Promise<void> {
  const cacheKey = `${url}:${action}:${target}`;
  const now = Date.now();
  
  // Update memory cache
  const entry: ActionCacheEntry = {
    action,
    target,
    url,
    result,
    selector,
    selectorType,
    timestamp: now,
    successCount: 1,
  };
  actionResultCache.set(cacheKey, entry);
  
  if (!actionCache) return;
  
  // Upsert in MongoDB
  await actionCache.updateOne(
    { url, action, target },
    {
      $set: {
        url,
        action,
        target,
        result,
        selector,
        selectorType,
        timestamp: now,
      },
      $inc: { successCount: 1 },
    },
    { upsert: true }
  );
}

export async function invalidateActionCache(url?: string): Promise<void> {
  actionResultCache.clear();
  
  if (!actionCache) return;
  
  if (url) {
    let domain = '';
    try {
      domain = new URL(url).hostname;
    } catch {}
    await actionCache.deleteMany({ url: { $regex: domain } });
  } else {
    await actionCache.deleteMany({});
  }
}

export async function getActionCacheStats(): Promise<{
  memorySize: number;
  mongoSize: number;
}> {
  const memorySize = actionResultCache.size;
  
  let mongoSize = 0;
  if (actionCache) {
    mongoSize = await actionCache.countDocuments();
  }
  
  return { memorySize, mongoSize };
}