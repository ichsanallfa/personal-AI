import test from "node:test";
import assert from "node:assert/strict";
import http from "http";
import app from "../src/app.js";
import { config } from "../src/config/env.js";

// Helper for testing express app without external dependencies
const makeRequest = (server, { method = "GET", path = "/", headers = {}, body = null }) => {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => (rawData += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(rawData);
          } catch {
            parsed = rawData;
          }
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        });
      }
    );

    req.on("error", reject);
    if (body) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
};

test("API: Health Check returns standard envelope", async (t) => {
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());

  const res = await makeRequest(server, { path: "/api/health" });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.equal(res.data.data.status, "healthy");
});

test("API: Validation error on missing chat message returns 400 with VALIDATION_ERROR code", async (t) => {
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());

  const res = await makeRequest(server, {
    method: "POST",
    path: "/api/chat",
    headers: {
      "x-service-key": config.serviceApiKey,
      "x-user-id": "api_test_user",
      "x-platform": "discord",
    },
    body: {},
  });

  assert.equal(res.status, 400);
  assert.equal(res.data.success, false);
  assert.equal(res.data.error.code, "VALIDATION_ERROR");
});

test("API: 404 for unknown endpoint returns NOT_FOUND standard error", async (t) => {
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());

  const res = await makeRequest(server, { path: "/api/non-existent-endpoint" });
  assert.equal(res.status, 404);
  assert.equal(res.data.success, false);
  assert.equal(res.data.error.code, "NOT_FOUND");
});

test("API: Chat endpoint rejects spoofed identity without authentication", async (t) => {
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());

  const res = await makeRequest(server, {
    method: "POST",
    path: "/api/chat",
    headers: {
      "x-user-id": "api_test_user",
    },
    body: {
      message: "Halo Lucy, ini tes otomatis",
      preferredProvider: "mock",
    },
  });

  assert.equal(res.status, 401);
  assert.equal(res.data.success, false);
  assert.equal(res.data.error.code, "UNAUTHORIZED");
});

test("API: Chat endpoint works with verified service key", async (t) => {
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());

  const res = await makeRequest(server, {
    method: "POST",
    path: "/api/chat",
    headers: {
      "x-service-key": config.serviceApiKey,
      "x-user-id": "api_test_user",
      "x-platform": "discord",
    },
    body: { message: "Halo Lucy, ini tes otomatis", preferredProvider: "mock" },
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);
  assert.ok(res.data.data.reply);
  assert.ok(res.data.reply);
});

test("API: CORS does not reflect arbitrary origins by default", async (t) => {
  const server = http.createServer(app).listen(0);
  t.after(() => server.close());
  const res = await makeRequest(server, { path: "/api/health", headers: { Origin: "https://attacker.example" } });
  assert.notEqual(res.headers["access-control-allow-origin"], "https://attacker.example");
});
