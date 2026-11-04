import test from "node:test";
import assert from "node:assert/strict";
import { authService } from "../src/services/auth/authService.js";
import { ROLES } from "../src/config/constants.js";
import { config } from "../src/config/env.js";
import { authenticate } from "../src/middlewares/auth.middleware.js";

test("Auth & Anti-Spoofing: Unauthenticated user cannot forge owner role", () => {
  const role = authService.evaluateRole("web", "Alfaa", false);
  assert.notEqual(role, ROLES.OWNER, "Spoofed username without credentials must not be owner");
});

test("Auth: Owner authentication with correct secret key returns owner role and JWT", () => {
  const result = authService.authenticateOwner(config.ownerSecretKey);
  assert.ok(result.token, "Must return JWT token");
  assert.equal(result.user.role, ROLES.OWNER, "Role must be owner");

  const verified = authService.verifyToken(result.token);
  assert.equal(verified.role, ROLES.OWNER);
});

test("Auth: Owner authentication with wrong secret throws error", () => {
  assert.throws(() => {
    authService.authenticateOwner("wrong_password");
  });
});

test("Auth: Bot-to-Backend Service Key validates platform user ID and assigns role", () => {
  config.discordOwnerId = "999888777";
  const botAuth = authService.authenticateBotRequest(
    config.serviceApiKey,
    "discord",
    "999888777"
  );
  assert.equal(botAuth.role, ROLES.OWNER, "Verified Discord owner must be granted owner role");
});

test("Auth: Bot-to-Backend Service Key with invalid key throws error", () => {
  assert.throws(() => {
    authService.authenticateBotRequest("invalid_key", "discord", "123");
  });
});

test("Auth: x-user-id alone never authenticates identity", () => {
  const req = { headers: { "x-user-id": "owner_alfaa", "x-platform": "discord" } };
  let nextCalled = false;
  authenticate(req, {}, (error) => {
    assert.equal(error, undefined);
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.user, null);
});

test("Auth: secrets use timing-safe equality and reject invalid values", () => {
  assert.throws(() => authService.authenticateBotRequest("wrong", "discord", "123"));
  assert.throws(() => authService.authenticateOwner("wrong"));
});

test("Auth: malformed identity headers cannot authenticate history access", async (t) => {
  const http = await import("node:http");
  const app = (await import("../src/app.js")).default;
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/chat/history`, {
    headers: { "x-user-id": "owner_alfaa", "x-platform": "discord" },
  });
  assert.equal(response.status, 401);
});
