import { describe, expect, it } from "vitest";
import { classifyFailure } from "../src/server/classify";

const facts = (text: string, category: string | null = null, httpStatusCode: number | null = null) => ({
  text,
  category,
  httpStatusCode,
});

describe("classifyFailure", () => {
  it("switches on rate limits, overload, 5xx and timeouts", () => {
    expect(classifyFailure(facts("", "rate-limit", 429))).toEqual({ switch: true, reason: { kind: "rate-limit", status: 429 } });
    expect(classifyFailure(facts("", "overloaded"))).toMatchObject({ switch: true, reason: { kind: "overloaded" } });
    expect(classifyFailure(facts("Provider error: 503 no_available_workers (all circuits open)"))).toEqual({
      switch: true,
      reason: { kind: "overloaded", status: 503 },
    });
    const gateway503 =
      "Internal error: Service Unavailable: {\"detail\":\"Error code: 503 - {'error': {'type': 'Service Unavailable', 'code': 'no_available_workers', 'message': 'No available workers (all circuits open or unhealthy)'}}\"}: {\"service\":\"session\",\"errorName\":\"APIError\"}";
    expect(classifyFailure(facts(gateway503, "internal"))).toEqual({ switch: true, reason: { kind: "overloaded", status: 503 } });
    expect(classifyFailure(facts("Internal error: Failed to execute statement", "internal"))).toEqual({ switch: false, why: "unknown" });
    expect(classifyFailure(facts("Too Many Requests"))).toMatchObject({ switch: true, reason: { kind: "rate-limit" } });
    expect(classifyFailure(facts("Bad gateway 502"))).toEqual({ switch: true, reason: { kind: "server-error", status: 502 } });
    expect(classifyFailure(facts("", null, 504))).toEqual({ switch: true, reason: { kind: "server-error", status: 504 } });
    expect(classifyFailure(facts("Request timed out after 480000ms"))).toEqual({ switch: true, reason: { kind: "timeout" } });
  });

  it("does not switch when no model was reached or the key was refused", () => {
    const vpnDown =
      'Internal error: getaddrinfo ENOTFOUND api.example.com: {"service":"session","errorName":"provider.transport"}';
    expect(classifyFailure(facts(vpnDown, "internal"))).toEqual({ switch: false, why: "connection" });
    expect(classifyFailure(facts("Cannot connect to API: Unable to connect"))).toEqual({ switch: false, why: "connection" });
    expect(classifyFailure(facts("", "connection-failed"))).toEqual({ switch: false, why: "connection" });
    expect(classifyFailure(facts("401 Unauthorized"))).toEqual({ switch: false, why: "auth" });
    expect(classifyFailure(facts("", null, 403))).toEqual({ switch: false, why: "auth" });
    expect(classifyFailure(facts("", null, 400))).toEqual({ switch: false, why: "request" });
    expect(classifyFailure(facts("something odd"))).toEqual({ switch: false, why: "unknown" });
  });

  it("stays fast on a huge hostile error text", () => {
    const started = Date.now();
    classifyFailure(facts("a".repeat(2_000_000) + " 5"));
    classifyFailure(facts("circuit ".repeat(200_000)));
    expect(Date.now() - started).toBeLessThan(500);
  });
});
