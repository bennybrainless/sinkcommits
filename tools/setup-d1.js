#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DB_NAME = process.env.SINK_DB_NAME || "sink_db";
const BINDING_NAME = "DB";

/**
 * Extracts a JSON substring from stdout that may include warnings or telemetry messages.
 */
function extractJson(text) {
  if (!text) return null;
  const startArray = text.indexOf("[");
  const endArray = text.lastIndexOf("]");
  if (startArray !== -1 && endArray !== -1 && endArray > startArray) {
    try {
      return JSON.parse(text.slice(startArray, endArray + 1));
    } catch (_) {}
  }

  const startObj = text.indexOf("{");
  const endObj = text.lastIndexOf("}");
  if (startObj !== -1 && endObj !== -1 && endObj > startObj) {
    try {
      return JSON.parse(text.slice(startObj, endObj + 1));
    } catch (_) {}
  }

  return null;
}

/**
 * Extracts UUID from text using standard UUID pattern.
 */
function extractUuid(text) {
  if (!text) return null;
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

/**
 * Lists existing D1 databases via wrangler CLI.
 */
function listD1Databases(execFn = execSync) {
  try {
    const stdout = execFn("npx wrangler d1 list --json", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const parsed = extractJson(stdout);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (err) {
    // If command fails with non-JSON output, attempt normal listing
    try {
      const stdout = execFn("npx wrangler d1 list", {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = stdout.split("\n");
      const dbs = [];
      for (const line of lines) {
        const uuid = extractUuid(line);
        if (uuid) {
          const parts = line.split(/[│|\s]+/).filter(Boolean);
          const namePart = parts.find((p) => p === DB_NAME) || parts[0];
          dbs.push({ name: namePart, uuid });
        }
      }
      return dbs;
    } catch (innerErr) {
      console.warn("[Sink Setup] Could not list D1 databases:", innerErr.message || innerErr);
    }
  }
  return [];
}

/**
 * Creates a new D1 database via wrangler CLI.
 */
function createD1Database(dbName, execFn = execSync) {
  console.log(`[Sink Setup] D1 database '${dbName}' not found. Creating database...`);
  try {
    const stdout = execFn(`npx wrangler d1 create ${dbName}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(stdout);

    // Try parsing JSON first
    const json = extractJson(stdout);
    if (json && (json.uuid || json.database_id)) {
      return json.uuid || json.database_id;
    }

    // Try extracting UUID from output
    const uuid = extractUuid(stdout);
    if (uuid && uuid !== "00000000-0000-0000-0000-000000000000") {
      return uuid;
    }
  } catch (err) {
    const errMsg = (err.stdout ? err.stdout.toString() : "") + " " + (err.stderr ? err.stderr.toString() : "");
    const uuid = extractUuid(errMsg);
    if (uuid && uuid !== "00000000-0000-0000-0000-000000000000") {
      return uuid;
    }
    throw new Error(`Failed to create D1 database '${dbName}': ${errMsg || err.message}`);
  }
  throw new Error(`Could not determine database ID after creating '${dbName}'.`);
}

/**
 * Resolves the database UUID for dbName, creating it if it doesn't already exist.
 */
function resolveDatabaseId(dbName = DB_NAME, execFn = execSync) {
  const existingList = listD1Databases(execFn);
  const found = existingList.find(
    (db) => db.name === dbName || db.database_name === dbName
  );

  if (found) {
    const uuid = found.uuid || found.database_id;
    if (uuid && uuid !== "00000000-0000-0000-0000-000000000000") {
      console.log(`[Sink Setup] Found existing D1 database '${dbName}' (ID: ${uuid})`);
      return uuid;
    }
  }

  return createD1Database(dbName, execFn);
}

/**
 * Updates a wrangler.json file with the resolved database ID.
 */
function updateWranglerJson(filePath, databaseId, dbName = DB_NAME) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  let json;
  try {
    json = JSON.parse(content);
  } catch (e) {
    console.warn(`[Sink Setup] Failed to parse ${filePath}:`, e.message);
    return false;
  }

  let modified = false;
  if (Array.isArray(json.d1_databases)) {
    for (const d1 of json.d1_databases) {
      if (d1.binding === BINDING_NAME || d1.database_name === dbName) {
        if (d1.database_id !== databaseId) {
          d1.database_id = databaseId;
          modified = true;
        }
      }
    }
  } else {
    json.d1_databases = [
      {
        binding: BINDING_NAME,
        database_name: dbName,
        database_id: databaseId,
      },
    ];
    modified = true;
  }

  if (modified) {
    fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + "\n", "utf8");
    console.log(`[Sink Setup] Updated ${filePath} with database_id: ${databaseId}`);
  }
  return modified;
}

/**
 * Updates a wrangler.toml file with the resolved database ID.
 */
function updateWranglerToml(filePath, databaseId, dbName = DB_NAME) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");

  let newContent = content;
  const idRegex = /database_id\s*=\s*"[^"]*"/;
  if (idRegex.test(content)) {
    newContent = content.replace(idRegex, `database_id = "${databaseId}"`);
  } else if (content.includes("[[d1_databases]]")) {
    newContent = content.replace(
      /(\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"[^"]*")/,
      `$1\ndatabase_id = "${databaseId}"`
    );
  }

  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, "utf8");
    console.log(`[Sink Setup] Updated ${filePath} with database_id: ${databaseId}`);
    return true;
  }
  return false;
}

/**
 * Updates all known configuration files in the project.
 */
function updateAllConfigs(rootDir, databaseId, dbName = DB_NAME) {
  const targets = [
    { path: path.join(rootDir, "wrangler.json"), type: "json" },
    { path: path.join(rootDir, "wrangler.toml"), type: "toml" },
    { path: path.join(rootDir, "backend", "wrangler.json"), type: "json" },
    { path: path.join(rootDir, "backend", "wrangler.toml"), type: "toml" },
  ];

  let updatedCount = 0;
  for (const target of targets) {
    if (target.type === "json") {
      if (updateWranglerJson(target.path, databaseId, dbName)) updatedCount++;
    } else if (target.type === "toml") {
      if (updateWranglerToml(target.path, databaseId, dbName)) updatedCount++;
    }
  }
  return updatedCount;
}

function main() {
  const rootDir = path.resolve(__dirname, "..");
  console.log(`[Sink Setup] Preparing D1 database '${DB_NAME}' for deployment...`);

  try {
    const databaseId = resolveDatabaseId(DB_NAME);
    console.log(`[Sink Setup] Using D1 database ID: ${databaseId}`);
    updateAllConfigs(rootDir, databaseId, DB_NAME);
    console.log("[Sink Setup] Configuration successfully prepared for deployment.");
  } catch (err) {
    console.error("[Sink Setup] Error during D1 setup:", err.message || err);
    // If running in local non-authenticated mode, do not crash build unless required
    if (process.env.CI || process.env.CF_PAGES || process.env.WORKERS_BUILDS) {
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractJson,
  extractUuid,
  listD1Databases,
  createD1Database,
  resolveDatabaseId,
  updateWranglerJson,
  updateWranglerToml,
  updateAllConfigs,
};
