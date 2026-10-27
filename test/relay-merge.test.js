import assert from "node:assert/strict";
import test from "node:test";
import { mergeRelayInfo } from "../src/vendor/innovvoip/relay-transport.mjs";

const base = (overrides = {}) => ({
  id: "1.2.3.4:3478",
  relayId: 0,
  ip: "1.2.3.4",
  port: 3478,
  originalPort: 3478,
  isIPv6: false,
  token: undefined,
  authToken: undefined,
  key: undefined,
  name: "offer-relay",
  enableEdgerayDtlsActiveMode: false,
  ...overrides,
});

test("mergeRelayInfo keeps authoritative relay credentials from event 156", () => {
  const existing = base({
    relayId: 2,
    token: "event-token",
    authToken: "event-auth",
    key: "event-key",
    name: "event-relay",
    enableEdgerayDtlsActiveMode: true,
  });
  const incoming = base({
    relayId: 0,
    token: Buffer.from("offer-token"),
    authToken: Buffer.from("offer-auth"),
    key: Buffer.from("offer-key"),
    name: "offer-relay",
  });

  const merged = mergeRelayInfo(existing, incoming);
  assert.equal(merged.relayId, 2);
  assert.equal(merged.token, "event-token");
  assert.equal(merged.authToken, "event-auth");
  assert.equal(merged.key, "event-key");
  assert.equal(merged.enableEdgerayDtlsActiveMode, true);
});

test("mergeRelayInfo fills missing credentials from the offer endpoint", () => {
  const existing = base({ relayId: 1, token: "", authToken: null, key: Buffer.alloc(0) });
  const incoming = base({
    token: Buffer.from("offer-token"),
    authToken: Buffer.from("offer-auth"),
    key: Buffer.from("offer-key"),
  });

  const merged = mergeRelayInfo(existing, incoming);
  assert.equal(merged.token.toString(), "offer-token");
  assert.equal(merged.authToken.toString(), "offer-auth");
  assert.equal(merged.key.toString(), "offer-key");
});

test("mergeRelayInfo works without an existing relay", () => {
  const incoming = base({ token: "offer-token", authToken: "offer-auth", key: "offer-key" });
  const merged = mergeRelayInfo(undefined, incoming);
  assert.equal(merged.token, "offer-token");
  assert.equal(merged.authToken, "offer-auth");
  assert.equal(merged.key, "offer-key");
});
