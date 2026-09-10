import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// @ts-ignore
import setupD1 from "../../tools/setup-d1.js";

describe("setup-d1 utility", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sink-d1-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("extractJson", () => {
    it("should parse pure JSON array", () => {
      const input = '[{"name":"sink_db","uuid":"11111111-2222-3333-4444-555555555555"}]';
      expect(setupD1.extractJson(input)).toEqual([
        { name: "sink_db", uuid: "11111111-2222-3333-4444-555555555555" },
      ]);
    });

    it("should parse JSON array surrounded by CLI warning logs", () => {
      const input = `
Cloudflare telemetry banner...
[
  {
    "uuid": "afe01f27-4cb9-40d5-a06c-8af5d50460ce",
    "name": "sink_db"
  }
]
Wrangler update available!
`;
      const result = setupD1.extractJson(input);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("sink_db");
      expect(result[0].uuid).toBe("afe01f27-4cb9-40d5-a06c-8af5d50460ce");
    });

    it("should return null for invalid text", () => {
      expect(setupD1.extractJson("plain text without json")).toBeNull();
    });
  });

  describe("extractUuid", () => {
    it("should extract valid UUID from stdout snippet", () => {
      const text = 'database_id = "afe01f27-4cb9-40d5-a06c-8af5d50460ce"';
      expect(setupD1.extractUuid(text)).toBe("afe01f27-4cb9-40d5-a06c-8af5d50460ce");
    });

    it("should return null when no UUID is found", () => {
      expect(setupD1.extractUuid("no uuid here")).toBeNull();
    });
  });

  describe("resolveDatabaseId", () => {
    it("should return databaseId and dbName of existing database if found in list", () => {
      const mockExec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("d1 list")) {
          return JSON.stringify([
            { name: "other_db", uuid: "00000000-1111-2222-3333-444444444444" },
            { name: "sink_db", uuid: "aabbccdd-1234-5678-9abc-def012345678" },
          ]);
        }
        return "";
      });

      const result = setupD1.resolveDatabaseId("sink_db", mockExec, tempDir);
      expect(result).toEqual({
        databaseId: "aabbccdd-1234-5678-9abc-def012345678",
        dbName: "sink_db",
      });
      expect(mockExec).toHaveBeenCalledTimes(1);
    });

    it("should call create if database is not in list", () => {
      const mockExec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("d1 list")) {
          return JSON.stringify([]);
        }
        if (cmd.includes("d1 create")) {
          return 'Created database sink_db with database_id = "99887766-5544-3322-1100-aabbccddeeff"';
        }
        return "";
      });

      const result = setupD1.resolveDatabaseId("sink_db", mockExec, tempDir);
      expect(result).toEqual({
        databaseId: "99887766-5544-3322-1100-aabbccddeeff",
        dbName: "sink_db",
      });
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("wrangler d1 create sink_db"),
        expect.anything()
      );
    });

    it("should pick the newest database by created_at when multiple exist", () => {
      const mockExec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("d1 list")) {
          return JSON.stringify([
            {
              name: "sinkdb",
              uuid: "old-1111-1111-1111-111111111111",
              created_at: "2024-01-01T00:00:00.000Z",
            },
            {
              name: "sink_db",
              uuid: "new-2222-2222-2222-222222222222",
              created_at: "2025-06-01T12:00:00.000Z",
            },
          ]);
        }
        return "";
      });

      const result = setupD1.resolveDatabaseId(undefined, mockExec, tempDir);
      expect(result.databaseId).toBe("new-2222-2222-2222-222222222222");
      expect(result.dbName).toBe("sink_db");
    });

    it("should prioritize custom database_name read from wrangler.json", () => {
      const jsonPath = path.join(tempDir, "wrangler.json");
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          d1_databases: [
            {
              binding: "DB",
              database_name: "my_custom_reading_db",
              database_id: "00000000-0000-0000-0000-000000000000",
            },
          ],
        })
      );

      const mockExec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("d1 list")) {
          return JSON.stringify([
            {
              name: "sink_db",
              uuid: "old-sink-1111-2222-333333333333",
              created_at: "2023-01-01T00:00:00.000Z",
            },
            {
              name: "my_custom_reading_db",
              uuid: "custom-4444-5555-6666-777777777777",
              created_at: "2025-01-01T00:00:00.000Z",
            },
          ]);
        }
        return "";
      });

      const result = setupD1.resolveDatabaseId(undefined, mockExec, tempDir);
      expect(result.databaseId).toBe("custom-4444-5555-6666-777777777777");
      expect(result.dbName).toBe("my_custom_reading_db");
    });

    it("should respect SINK_DB_ID and SINK_DB_NAME environment variables", () => {
      const originalDbId = process.env.SINK_DB_ID;
      const originalDbName = process.env.SINK_DB_NAME;

      try {
        process.env.SINK_DB_ID = "eeeeeeee-ffff-aaaa-bbbb-cccccccccccc";
        process.env.SINK_DB_NAME = "env_overridden_db";

        const mockExec = vi.fn();
        const result = setupD1.resolveDatabaseId(undefined, mockExec, tempDir);

        expect(result.databaseId).toBe("eeeeeeee-ffff-aaaa-bbbb-cccccccccccc");
        expect(result.dbName).toBe("env_overridden_db");
        expect(mockExec).not.toHaveBeenCalled();
      } finally {
        if (originalDbId !== undefined) {
          process.env.SINK_DB_ID = originalDbId;
        } else {
          delete process.env.SINK_DB_ID;
        }
        if (originalDbName !== undefined) {
          process.env.SINK_DB_NAME = originalDbName;
        } else {
          delete process.env.SINK_DB_NAME;
        }
      }
    });

    it("should preserve verified pre-existing database_id in wrangler.json", () => {
      const jsonPath = path.join(tempDir, "wrangler.json");
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          d1_databases: [
            {
              binding: "DB",
              database_name: "sink_db",
              database_id: "existing-valid-1111-2222-333333333333",
            },
          ],
        })
      );

      const mockExec = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes("d1 list")) {
          return JSON.stringify([
            {
              name: "sink_db",
              uuid: "existing-valid-1111-2222-333333333333",
            },
          ]);
        }
        return "";
      });

      const result = setupD1.resolveDatabaseId(undefined, mockExec, tempDir);
      expect(result.databaseId).toBe("existing-valid-1111-2222-333333333333");
      expect(result.dbName).toBe("sink_db");
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("d1 list"),
        expect.anything()
      );
    });
  });

  describe("updateWranglerJson", () => {
    it("should update database_id in wrangler.json", () => {
      const jsonPath = path.join(tempDir, "wrangler.json");
      fs.writeFileSync(
        jsonPath,
        JSON.stringify({
          name: "sink",
          d1_databases: [
            {
              binding: "DB",
              database_name: "sink_db",
              database_id: "00000000-0000-0000-0000-000000000000",
            },
          ],
        }, null, 2)
      );

      const modified = setupD1.updateWranglerJson(
        jsonPath,
        "12345678-abcd-ef01-2345-6789abcdef01",
        "sink_db"
      );

      expect(modified).toBe(true);
      const updated = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      expect(updated.d1_databases[0].database_id).toBe("12345678-abcd-ef01-2345-6789abcdef01");
    });
  });

  describe("updateWranglerToml", () => {
    it("should update database_id in wrangler.toml", () => {
      const tomlPath = path.join(tempDir, "wrangler.toml");
      fs.writeFileSync(
        tomlPath,
        `name = "sink"
[[d1_databases]]
binding = "DB"
database_name = "sink_db"
database_id = "00000000-0000-0000-0000-000000000000"
`
      );

      const modified = setupD1.updateWranglerToml(
        tomlPath,
        "fedcba98-7654-3210-fedc-ba9876543210",
        "sink_db"
      );

      expect(modified).toBe(true);
      const updated = fs.readFileSync(tomlPath, "utf8");
      expect(updated).toContain('database_id = "fedcba98-7654-3210-fedc-ba9876543210"');
      expect(updated).not.toContain("00000000-0000-0000-0000-000000000000");
    });
  });

  describe("updateAllConfigs", () => {
    it("should update all existing config files in directory structure", () => {
      fs.mkdirSync(path.join(tempDir, "backend"), { recursive: true });

      const rootJson = path.join(tempDir, "wrangler.json");
      const rootToml = path.join(tempDir, "wrangler.toml");
      const backendJson = path.join(tempDir, "backend", "wrangler.json");
      const backendToml = path.join(tempDir, "backend", "wrangler.toml");

      fs.writeFileSync(rootJson, JSON.stringify({ d1_databases: [{ binding: "DB", database_name: "sink_db", database_id: "00000000-0000-0000-0000-000000000000" }] }));
      fs.writeFileSync(rootToml, '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "sink_db"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n');
      fs.writeFileSync(backendJson, JSON.stringify({ d1_databases: [{ binding: "DB", database_name: "sink_db", database_id: "00000000-0000-0000-0000-000000000000" }] }));
      fs.writeFileSync(backendToml, '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "sink_db"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n');

      const count = setupD1.updateAllConfigs(tempDir, "deadbeef-1234-5678-9abc-def012345678", "sink_db");
      expect(count).toBe(4);

      expect(JSON.parse(fs.readFileSync(rootJson, "utf8")).d1_databases[0].database_id).toBe("deadbeef-1234-5678-9abc-def012345678");
      expect(fs.readFileSync(rootToml, "utf8")).toContain('database_id = "deadbeef-1234-5678-9abc-def012345678"');
      expect(JSON.parse(fs.readFileSync(backendJson, "utf8")).d1_databases[0].database_id).toBe("deadbeef-1234-5678-9abc-def012345678");
      expect(fs.readFileSync(backendToml, "utf8")).toContain('database_id = "deadbeef-1234-5678-9abc-def012345678"');
    });
  });
});
