#!/usr/bin/env node

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_DB_NAME = "sink_db";
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
 * Reads existing configuration from wrangler.json or wrangler.toml to detect
 * any user-customized database_name or pre-existing valid database_id.
 */
function readConfiguredDbInfo(rootDir) {
  const jsonPath = path.join(rootDir, "wrangler.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (Array.isArray(data.d1_databases)) {
        const entry = data.d1_databases.find((d) => d.binding === BINDING_NAME) || data.d1_databases[0];
        if (entry) {
          const dbName = entry.database_name;
          const dbId = entry.database_id;
          return {
            database_name: dbName || null,
            database_id: (dbId && dbId !== "00000000-0000-0000-0000-000000000000") ? dbId : null,
          };
        }
      }
    } catch (_) {}
  }

  const tomlPath = path.join(rootDir, "wrangler.toml");
  if (fs.existsSync(tomlPath)) {
    try {
      const content = fs.readFileSync(tomlPath, "utf8");
      const nameMatch = content.match(/database_name\s*=\s*"([^"]+)"/);
      const idMatch = content.match(/database_id\s*=\s*"([^"]+)"/);
      const dbName = nameMatch ? nameMatch[1] : null;
      const dbId = idMatch ? idMatch[1] : null;
      return {
        database_name: dbName || null,
        database_id: (dbId && dbId !== "00000000-0000-0000-0000-000000000000") ? dbId : null,
      };
    } catch (_) {}
  }

  return { database_name: null, database_id: null };
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
          const namePart = parts.find((p) => p.includes("sink") || p.includes("db")) || parts[0];
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

    const json = extractJson(stdout);
    if (json && (json.uuid || json.database_id)) {
      return json.uuid || json.database_id;
    }

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
 * Resolves the database UUID using priority:
 * 1. SINK_DB_ID environment variable.
 * 2. Pre-existing valid database_id from configuration (if verified in account).
 * 3. SINK_DB_NAME env var or customized database_name from wrangler config.
 * 4. When multiple databases exist (e.g. an older sinkdb and a newer one),
 *    select the newest database by created_at timestamp.
 * 5. Auto-create if no match exists.
 */
function resolveDatabaseId(targetDbName, execFn = execSync, rootDir = path.resolve(__dirname, "..")) {
  const configured = readConfiguredDbInfo(rootDir);
  const effectiveDbName = process.env.SINK_DB_NAME || targetDbName || configured.database_name || DEFAULT_DB_NAME;

  if (process.env.SINK_DB_ID) {
    const envId = extractUuid(process.env.SINK_DB_ID);
    if (envId && envId !== "00000000-0000-0000-0000-000000000000") {
      console.log(`[Sink Setup] Using explicit SINK_DB_ID from environment: ${envId}`);
      return { databaseId: envId, dbName: effectiveDbName };
    }
  }

  const existingList = listD1Databases(execFn);

  // If a valid non-placeholder database_id is already configured and verified to exist, keep it!
  if (configured.database_id) {
    const exists = existingList.some(
      (db) => (db.uuid || db.database_id) === configured.database_id
    );
    if (exists) {
      console.log(`[Sink Setup] Preserving verified existing database_id from configuration: ${configured.database_id}`);
      return { databaseId: configured.database_id, dbName: effectiveDbName };
    }
  }

  // Find matching databases in account
  let matches = existingList.filter(
    (db) => db.name === effectiveDbName || db.database_name === effectiveDbName
  );

  // If no exact match and user is using default sink_db, also look for legacy sinkdb
  if (matches.length === 0 && (effectiveDbName === "sink_db" || effectiveDbName === "sinkdb")) {
    matches = existingList.filter(
      (db) => db.name === "sink_db" || db.name === "sinkdb" || db.database_name === "sink_db" || db.database_name === "sinkdb"
    );
  }

  if (matches.length > 0) {
    // Sort by created_at descending if available so newest database is chosen
    matches.sort((a, b) => {
      const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return timeB - timeA;
    });

    const selected = matches[0];
    const uuid = selected.uuid || selected.database_id;
    if (uuid && uuid !== "00000000-0000-0000-0000-000000000000") {
      console.log(
        `[Sink Setup] Found existing D1 database '${selected.name}' (ID: ${uuid}${
          selected.created_at ? `, created: ${selected.created_at}` : ""
        })`
      );
      return { databaseId: uuid, dbName: selected.name || effectiveDbName };
    }
  }

  // Auto-create database with effectiveDbName if none found
  const newId = createD1Database(effectiveDbName, execFn);
  return { databaseId: newId, dbName: effectiveDbName };
}

/**
 * Updates a wrangler.json file with the resolved database ID and name.
 */
function updateWranglerJson(filePath, databaseId, dbName = DEFAULT_DB_NAME) {
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
        if (d1.database_id !== databaseId || d1.database_name !== dbName) {
          d1.database_id = databaseId;
          d1.database_name = dbName;
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
    console.log(`[Sink Setup] Updated ${filePath} with database_id: ${databaseId} (${dbName})`);
  }
  return modified;
}

/**
 * Updates a wrangler.toml file with the resolved database ID and name.
 */
function updateWranglerToml(filePath, databaseId, dbName = DEFAULT_DB_NAME) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");

  let newContent = content;
  const idRegex = /database_id\s*=\s*"[^"]*"/;
  if (idRegex.test(newContent)) {
    newContent = newContent.replace(idRegex, `database_id = "${databaseId}"`);
  } else if (newContent.includes("[[d1_databases]]")) {
    newContent = newContent.replace(
      /(\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"[^"]*")/,
      `$1\ndatabase_id = "${databaseId}"`
    );
  }

  const nameRegex = /database_name\s*=\s*"[^"]*"/;
  if (nameRegex.test(newContent)) {
    newContent = newContent.replace(nameRegex, `database_name = "${dbName}"`);
  }

  if (newContent !== content) {
    fs.writeFileSync(filePath, newContent, "utf8");
    console.log(`[Sink Setup] Updated ${filePath} with database_id: ${databaseId} (${dbName})`);
    return true;
  }
  return false;
}

/**
 * Updates all known configuration files in the project.
 */
function updateAllConfigs(rootDir, databaseId, dbName = DEFAULT_DB_NAME) {
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
  console.log(`[Sink Setup] Preparing D1 database configuration for deployment...`);

  try {
    const { databaseId, dbName } = resolveDatabaseId(undefined, execSync, rootDir);
    console.log(`[Sink Setup] Using D1 database '${dbName}' (ID: ${databaseId})`);
    updateAllConfigs(rootDir, databaseId, dbName);
    console.log("[Sink Setup] Configuration successfully prepared for deployment.");
  } catch (err) {
    console.error("[Sink Setup] Error during D1 setup:", err.message || err);
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
  readConfiguredDbInfo,
  listD1Databases,
  createD1Database,
  resolveDatabaseId,
  updateWranglerJson,
  updateWranglerToml,
  updateAllConfigs,
};
