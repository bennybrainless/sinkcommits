import { describe, it, expect } from "vitest";
import {
  hashPassword,
  hashPasswordPBKDF2,
  hashPasswordLegacy,
  verifyPassword,
  hashPin,
  verifyPin,
  timingSafeEqual,
  isValidKeyField,
} from "../src/auth";

describe("Auth Utilities", () => {
  it("generates and verifies PBKDF2 password hashes", async () => {
    const hash = await hashPassword("mySecretPassword123");
    expect(typeof hash).toBe("string");
    expect(hash.startsWith("pbkdf2:100000:")).toBe(true);

    const check1 = await verifyPassword("mySecretPassword123", hash);
    expect(check1.valid).toBe(true);
    expect(check1.needsRehash).toBe(false);

    const check2 = await verifyPassword("wrongPassword", hash);
    expect(check2.valid).toBe(false);
  });

  it("verifies and flags legacy SHA-256 password hashes for rehash", async () => {
    const legacyHash = await hashPasswordLegacy("mySecretPassword123");
    expect(legacyHash.length).toBe(64);

    const check = await verifyPassword("mySecretPassword123", legacyHash);
    expect(check.valid).toBe(true);
    expect(check.needsRehash).toBe(true);

    const badCheck = await verifyPassword("wrongPassword", legacyHash);
    expect(badCheck.valid).toBe(false);
  });

  it("hashes and verifies pairing PINs securely", async () => {
    const pinHash = await hashPin("1234");
    expect(pinHash.startsWith("pbkdf2:100000:")).toBe(true);

    const valid = await verifyPin("1234", pinHash);
    expect(valid).toBe(true);

    const invalid = await verifyPin("9999", pinHash);
    expect(invalid).toBe(false);

    // Also supports plaintext environment secrets
    expect(await verifyPin("5678", "5678")).toBe(true);
    expect(await verifyPin("0000", "5678")).toBe(false);
  });

  it("safely compares strings with timingSafeEqual", () => {
    expect(timingSafeEqual("abc123xyz", "abc123xyz")).toBe(true);
    expect(timingSafeEqual("abc123xyz", "abc123xyw")).toBe(false);
    expect(timingSafeEqual("short", "longer_string")).toBe(false);
  });

  it("validates valid key fields", () => {
    expect(isValidKeyField("valid_user")).toBe(true);
    expect(isValidKeyField("user-123")).toBe(true);
    expect(isValidKeyField("")).toBe(false);
    expect(isValidKeyField("invalid:user")).toBe(false); // contains colon
    expect(isValidKeyField(null)).toBe(false);
    expect(isValidKeyField(undefined)).toBe(false);
  });
});
