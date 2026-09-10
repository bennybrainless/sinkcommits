import { describe, it, expect, beforeEach } from "vitest";
import app from "../src/index";
import { createMockD1 } from "./mock-d1";
import { Env } from "../src/types";

describe("KOReader Kosync API Endpoints", () => {
  let env: Env;

  beforeEach(() => {
    env = {
      DB: createMockD1(),
    };
  });

  describe("Health Check Endpoints", () => {
    it("returns 200 OK for /health", async () => {
      const res = await app.request("/health", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.status).toBe("ok");
      expect(data.state).toBe("OK");
    });

    it("returns 200 OK for /healthcheck", async () => {
      const res = await app.request("/healthcheck", {}, env);
      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.state).toBe("OK");
    });
  });

  describe("Code-Based Pairing Flow (/api/session)", () => {
    it("creates a new 6-character pairing session with secret poll_token", async () => {
      const res = await app.request(
        "/api/session/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
        env
      );

      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.success).toBe(true);
      expect(typeof data.session_id).toBe("string");
      expect(data.session_id.length).toBe(6);
      expect(typeof data.poll_token).toBe("string");
      expect(data.poll_token.length).toBe(32);
      expect(data.expires_in).toBe(600);
    });

    it("rejects polling without valid poll_token", async () => {
      const createRes = await app.request(
        "/api/session/create",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        env
      );
      const { session_id } = await createRes.json<any>();

      // Polling without X-Poll-Token should fail with 401
      const pollRes = await app.request(`/api/session/${session_id}/poll`, { method: "GET" }, env);
      expect(pollRes.status).toBe(401);
      const pollData = await pollRes.json<any>();
      expect(pollData.error).toContain("Unauthorized");
    });

    it("handles full pairing lifecycle between e-reader and phone browser with PIN", async () => {
      // 1. E-reader creates session
      const createRes = await app.request(
        "/api/session/create",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        env
      );
      const { session_id, poll_token } = await createRes.json<any>();

      // 2. Initial poll with valid poll_token returns 204 No Content (waiting for phone)
      const pollRes1 = await app.request(
        `/api/session/${session_id}/poll`,
        { method: "GET", headers: { "x-poll-token": poll_token } },
        env
      );
      expect(pollRes1.status).toBe(204);

      // 3. User sets up PIN and clicks Connect on phone
      const submitRes = await app.request(
        `/api/session/${session_id}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "my_kindle", pin: "1234" }),
        },
        env
      );
      expect(submitRes.status).toBe(200);
      const submitData = await submitRes.json<any>();
      expect(submitData.success).toBe(true);

      // 4. E-reader poll now receives credentials
      const pollRes2 = await app.request(
        `/api/session/${session_id}/poll`,
        { method: "GET", headers: { "x-poll-token": poll_token } },
        env
      );
      expect(pollRes2.status).toBe(200);
      const pollData = await pollRes2.json<any>();
      expect(pollData.success).toBe(true);
      expect(pollData.status).toBe("ready");
      expect(pollData.username).toBe("my_kindle");
      expect(typeof pollData.userkey).toBe("string");
    });

    it("requires PIN for subsequent device pairing and shares sync_key", async () => {
      // 1. First device pairs and establishes PIN 1234
      const createRes1 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s1, poll_token: pt1 } = await createRes1.json<any>();
      await app.request(`/api/session/${s1}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "1234" }) }, env);

      const pollRes1 = await app.request(`/api/session/${s1}/poll`, { method: "GET", headers: { "x-poll-token": pt1 } }, env);
      const { userkey: d1_key } = await pollRes1.json<any>();
      expect(d1_key).toBeTruthy();

      // 2. Second device attempts pairing without PIN -> should fail with 401
      const createRes2 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s2, poll_token: pt2 } = await createRes2.json<any>();

      const failedSubmit = await app.request(
        `/api/session/${s2}/submit`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader" }) },
        env
      );
      expect(failedSubmit.status).toBe(401);

      // 3. Second device pairs with wrong PIN -> should fail with 401
      const wrongPinSubmit = await app.request(
        `/api/session/${s2}/submit`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "9999" }) },
        env
      );
      expect(wrongPinSubmit.status).toBe(401);

      // 4. Second device pairs with correct PIN -> succeeds and receives same sync_key
      const correctSubmit = await app.request(
        `/api/session/${s2}/submit`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "1234" }) },
        env
      );
      expect(correctSubmit.status).toBe(200);

      const pollRes2 = await app.request(`/api/session/${s2}/poll`, { method: "GET", headers: { "x-poll-token": pt2 } }, env);
      const { userkey: d2_key } = await pollRes2.json<any>();
      expect(d2_key).toBe(d1_key);

      // 5. Both devices can authenticate simultaneously
      const auth1 = await app.request("/users/auth", { method: "GET", headers: { "x-auth-user": "primary_reader", "x-auth-key": d1_key } }, env);
      expect(auth1.status).toBe(200);

      const auth2 = await app.request("/users/auth", { method: "GET", headers: { "x-auth-user": "primary_reader", "x-auth-key": d2_key } }, env);
      expect(auth2.status).toBe(200);
    });

    it("prevents account takeover: /submit cannot overwrite existing credentials", async () => {
      // 1. Initial pairing
      const createRes1 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s1, poll_token: pt1 } = await createRes1.json<any>();
      await app.request(`/api/session/${s1}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "1234" }) }, env);
      const { userkey: originalKey } = await (await app.request(`/api/session/${s1}/poll`, { method: "GET", headers: { "x-poll-token": pt1 } }, env)).json<any>();

      // 2. Attacker attempts to overwrite account credentials with their own key without PIN
      const createRes2 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s2 } = await createRes2.json<any>();
      const attackRes = await app.request(
        `/api/session/${s2}/submit`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", userkey: "attacker_new_key" }) },
        env
      );
      expect(attackRes.status).toBe(401);

      // 3. Original credentials remain valid and untouched
      const authCheck = await app.request("/users/auth", { method: "GET", headers: { "x-auth-user": "primary_reader", "x-auth-key": originalKey } }, env);
      expect(authCheck.status).toBe(200);
    });

    it("allows resetting PIN from authenticated device via /api/session/reset-pin", async () => {
      // 1. Initial setup with PIN 1234
      const createRes1 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s1, poll_token: pt1 } = await createRes1.json<any>();
      await app.request(`/api/session/${s1}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "1234" }) }, env);
      const { userkey: d1_key } = await (await app.request(`/api/session/${s1}/poll`, { method: "GET", headers: { "x-poll-token": pt1 } }, env)).json<any>();

      // 2. Unauthenticated caller attempts to reset PIN -> rejected with 401
      const unauthReset = await app.request("/api/session/reset-pin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_pin: "5678" }) }, env);
      expect(unauthReset.status).toBe(401);

      // 3. Authenticated device resets PIN to 5678
      const authReset = await app.request(
        "/api/session/reset-pin",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-user": "primary_reader",
            "x-auth-key": d1_key,
          },
          body: JSON.stringify({ new_pin: "5678" }),
        },
        env
      );
      expect(authReset.status).toBe(200);

      // 4. Old PIN 1234 is no longer accepted
      const createRes2 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s2 } = await createRes2.json<any>();
      const oldPinSubmit = await app.request(`/api/session/${s2}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "1234" }) }, env);
      expect(oldPinSubmit.status).toBe(401);

      // 5. New PIN 5678 is accepted
      const newPinSubmit = await app.request(`/api/session/${s2}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "5678" }) }, env);
      expect(newPinSubmit.status).toBe(200);
    });

    it("creates user in D1 when pairing with pre-configured PAIRING_PIN environment variable", async () => {
      // Server configured with env PIN, but database has NO user yet
      const envWithPin = { ...env, PAIRING_PIN: "9999" };
      const createRes = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, envWithPin);
      const { session_id, poll_token } = await createRes.json<any>();

      const submitRes = await app.request(
        `/api/session/${session_id}/submit`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "fresh_reader", pin: "9999" }) },
        envWithPin
      );
      expect(submitRes.status).toBe(200);

      const pollRes = await app.request(`/api/session/${session_id}/poll`, { method: "GET", headers: { "x-poll-token": poll_token } }, envWithPin);
      const { userkey } = await pollRes.json<any>();
      expect(userkey).toBeDefined();

      // Ensure user can authenticate immediately against D1
      const authRes = await app.request(
        "/users/auth",
        { method: "GET", headers: { "x-auth-user": "fresh_reader", "x-auth-key": userkey } },
        envWithPin
      );
      expect(authRes.status).toBe(200);
    });

    it("reports server configuration status correctly", async () => {
      // Before setup: is_configured is false
      const res1 = await app.request("/api/session/status", { method: "GET" }, env);
      expect(res1.status).toBe(200);
      const data1 = await res1.json<any>();
      expect(data1.is_configured).toBe(false);

      // Setup server
      const createRes = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id } = await createRes.json<any>();
      await app.request(`/api/session/${session_id}/submit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "primary_reader", pin: "1234" }) }, env);

      // After setup: is_configured is true
      const res2 = await app.request("/api/session/status", { method: "GET" }, env);
      expect(res2.status).toBe(200);
      const data2 = await res2.json<any>();
      expect(data2.is_configured).toBe(true);
    });

    it("supports 1-year trusted browser tokens, bypasses PIN on trusted submit, and revokes properly", async () => {
      // 1. Initial pairing with trust_browser = true
      const createRes1 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s1 } = await createRes1.json<any>();

      const submitRes1 = await app.request(
        `/api/session/${s1}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "primary_reader", pin: "1234", trust_browser: true }),
        },
        env
      );
      expect(submitRes1.status).toBe(200);
      const submitData1 = await submitRes1.json<any>();
      expect(submitData1.success).toBe(true);
      expect(typeof submitData1.browser_token).toBe("string");
      expect(submitData1.browser_token.length).toBe(64);

      const browserToken = submitData1.browser_token;

      // 2. Status check with browser token reports browser_trusted = true
      const statusRes = await app.request(
        "/api/session/status",
        {
          method: "GET",
          headers: { "x-browser-token": browserToken },
        },
        env
      );
      expect(statusRes.status).toBe(200);
      const statusData = await statusRes.json<any>();
      expect(statusData.browser_trusted).toBe(true);

      // 3. Pairing second device without entering PIN, using browser_token
      const createRes2 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s2 } = await createRes2.json<any>();

      const submitRes2 = await app.request(
        `/api/session/${s2}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "primary_reader", browser_token: browserToken }),
        },
        env
      );
      expect(submitRes2.status).toBe(200);
      const submitData2 = await submitRes2.json<any>();
      expect(submitData2.success).toBe(true);

      // 4. Revoking the browser token
      const revokeRes = await app.request(
        "/api/session/revoke-browser",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ browser_token: browserToken }),
        },
        env
      );
      expect(revokeRes.status).toBe(200);
      const revokeData = await revokeRes.json<any>();
      expect(revokeData.success).toBe(true);

      // 5. Status check now reports browser_trusted = false
      const statusAfterRevoke = await app.request(
        "/api/session/status",
        {
          method: "GET",
          headers: { "x-browser-token": browserToken },
        },
        env
      );
      const revokeStatusData = await statusAfterRevoke.json<any>();
      expect(revokeStatusData.browser_trusted).toBe(false);

      // 6. Submitting with revoked token without PIN is rejected
      const createRes3 = await app.request("/api/session/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }, env);
      const { session_id: s3 } = await createRes3.json<any>();
      const submitRejected = await app.request(
        `/api/session/${s3}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "primary_reader", browser_token: browserToken }),
        },
        env
      );
      expect(submitRejected.status).toBe(401);
    });
  });

  describe("User Registration (/users/create)", () => {
    it("registers a new user successfully", async () => {
      const res = await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "testuser", password: "secretpassword" }),
        },
        env
      );

      expect(res.status).toBe(201);
      const data = await res.json<any>();
      expect(data.username).toBe("testuser");
    });

    it("rejects duplicate user with 402 / code 2002", async () => {
      // First registration
      await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "existinguser", password: "secretpassword" }),
        },
        env
      );

      // Duplicate registration
      const res = await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "existinguser", password: "secretpassword" }),
        },
        env
      );

      expect(res.status).toBe(402);
      const data = await res.json<any>();
      expect(data.code).toBe(2002);
      expect(data.message).toBe("Username is already registered.");
    });

    it("rejects invalid characters (colons) in username", async () => {
      const res = await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "user:with:colon", password: "secretpassword" }),
        },
        env
      );

      expect(res.status).toBe(403);
      const data = await res.json<any>();
      expect(data.code).toBe(2003);
    });
  });

  describe("User Authentication (/users/auth)", () => {
    beforeEach(async () => {
      // Register test user
      await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "reader1", password: "mypassword" }),
        },
        env
      );
    });

    it("authenticates via x-auth-user and x-auth-key headers", async () => {
      const res = await app.request(
        "/users/auth",
        {
          method: "GET",
          headers: {
            "x-auth-user": "reader1",
            "x-auth-key": "mypassword",
          },
        },
        env
      );

      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.authorized).toBe("OK");
    });

    it("authenticates via POST JSON body", async () => {
      const res = await app.request(
        "/users/auth",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "reader1", password: "mypassword" }),
        },
        env
      );

      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data.authorized).toBe("OK");
    });

    it("rejects invalid password with 401 Unauthorized", async () => {
      const res = await app.request(
        "/users/auth",
        {
          method: "GET",
          headers: {
            "x-auth-user": "reader1",
            "x-auth-key": "wrongpassword",
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const data = await res.json<any>();
      expect(data.code).toBe(2001);
      expect(data.message).toBe("Unauthorized");
    });

    it("rejects non-existent user with 401 Unauthorized", async () => {
      const res = await app.request(
        "/users/auth",
        {
          method: "GET",
          headers: {
            "x-auth-user": "nonexistent",
            "x-auth-key": "somepassword",
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const data = await res.json<any>();
      expect(data.code).toBe(2001);
    });
  });

  describe("Reading Progress Synchronization (/syncs/progress)", () => {
    const username = "kindle_user";
    const userKey = "kindle_pass";
    const docHash = "0b229176d4e8db7f6d2b5a4952368d7a";

    beforeEach(async () => {
      await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: userKey }),
        },
        env
      );
    });

    it("returns empty object for non-existent document progress", async () => {
      const res = await app.request(
        `/syncs/progress/${docHash}`,
        {
          method: "GET",
          headers: {
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
        },
        env
      );

      expect(res.status).toBe(200);
      const data = await res.json<any>();
      expect(data).toEqual({});
    });

    it("requires authentication for progress operations", async () => {
      const getRes = await app.request(`/syncs/progress/${docHash}`, {}, env);
      expect(getRes.status).toBe(401);

      const putRes = await app.request(
        "/syncs/progress",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            document: docHash,
            percentage: 0.5,
            progress: "/body/DocFragment[5]/p[1]",
            device: "Kindle Paperwhite",
          }),
        },
        env
      );
      expect(putRes.status).toBe(401);
    });

    it("saves and updates reading progress", async () => {
      // 1. Initial progress update
      const putRes1 = await app.request(
        "/syncs/progress",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
          body: JSON.stringify({
            document: docHash,
            percentage: 0.318,
            progress: "/body/DocFragment[20]/body/p[22]/img.0",
            device: "Kindle Paperwhite",
            device_id: "dev_kindle_01",
          }),
        },
        env
      );

      expect(putRes1.status).toBe(200);
      const putData1 = await putRes1.json<any>();
      expect(putData1.document).toBe(docHash);
      expect(typeof putData1.timestamp).toBe("number");

      // 2. Fetch saved progress
      const getRes1 = await app.request(
        `/syncs/progress/${docHash}`,
        {
          method: "GET",
          headers: {
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
        },
        env
      );

      expect(getRes1.status).toBe(200);
      const getData1 = await getRes1.json<any>();
      expect(getData1.document).toBe(docHash);
      expect(getData1.percentage).toBeCloseTo(0.318);
      expect(getData1.progress).toBe("/body/DocFragment[20]/body/p[22]/img.0");
      expect(getData1.device).toBe("Kindle Paperwhite");
      expect(getData1.device_id).toBe("dev_kindle_01");
      expect(typeof getData1.timestamp).toBe("number");

      // 3. Update to further progress from another device
      const putRes2 = await app.request(
        "/syncs/progress",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
          body: JSON.stringify({
            document: docHash,
            percentage: 0.582,
            progress: "/body/DocFragment[35]/body/p[10]/text.1",
            device: "KOReader Android",
            device_id: "dev_android_02",
          }),
        },
        env
      );

      expect(putRes2.status).toBe(200);

      // 4. Verify updated state
      const getRes2 = await app.request(
        `/syncs/progress/${docHash}`,
        {
          method: "GET",
          headers: {
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
        },
        env
      );

      const getData2 = await getRes2.json<any>();
      expect(getData2.percentage).toBeCloseTo(0.582);
      expect(getData2.progress).toBe("/body/DocFragment[35]/body/p[10]/text.1");
      expect(getData2.device).toBe("KOReader Android");
    });

    it("bridges progress between phone and WSL when document hashes differ using book_key", async () => {
      const username = "cross_device_user";
      const userKey = "sync_key_cross_device";

      // Register / Auth user
      await app.request(
        "/users/create",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: userKey }),
        },
        env
      );

      const phoneHash = "hash_phone_binary_1111";
      const wslHash = "hash_wsl_binary_2222";

      // 1. Phone syncs reading progress under its own binary hash with book title
      const phonePutRes = await app.request(
        "/syncs/progress",
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
          body: JSON.stringify({
            document: phoneHash,
            percentage: 0.225,
            progress: "/body/DocFragment[8]/body/div/section/p[4]/text().34",
            device: "akita",
            title: "Career of Evil",
            authors: "Robert Galbraith",
          }),
        },
        env
      );
      expect(phonePutRes.status).toBe(200);

      // 2. WSL opens the book under its own completely different hash, but provides title/authors
      const wslGetRes = await app.request(
        `/syncs/progress/${wslHash}?title=${encodeURIComponent("Career of Evil (Cormoran Strike)")}&authors=${encodeURIComponent("Robert Galbraith")}`,
        {
          method: "GET",
          headers: {
            "x-auth-user": username,
            "x-auth-key": userKey,
          },
        },
        env
      );

      expect(wslGetRes.status).toBe(200);
      const wslData = await wslGetRes.json<any>();
      expect(wslData.percentage).toBeCloseTo(0.225);
      expect(wslData.progress).toBe("/body/DocFragment[8]/body/div/section/p[4]/text().34");
      expect(wslData.device).toBe("akita");
    });
  });
});
