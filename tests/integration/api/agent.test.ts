const mockGetAgentStatus = jest.fn();

jest.mock("../../../src/agent/loop", () => ({
  getAgentStatus: () => mockGetAgentStatus(),
}));

import request from "supertest";
import app from "../../../src/index";

describe("Agent route", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 with normalized status payload", async () => {
    mockGetAgentStatus.mockReturnValue({
      isRunning: true,
      lastRebalanceAt: new Date("2026-04-26T10:00:00.000Z"),
      currentProtocol: "Blend",
      currentApy: 7.1234,
      nextScheduledCheck: new Date("2026-04-26T11:00:00.000Z"),
      lastError: null,
      healthStatus: "healthy",
    });

    const res = await request(app).get("/api/agent/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: {
        isRunning: true,
        currentProtocol: "Blend",
        currentApy: "7.12",
        lastError: null,
        healthStatus: "healthy",
      },
    });
    expect(res.body.data.timestamp).toEqual(expect.any(String));
  });

  it("returns 500 when status provider throws", async () => {
    mockGetAgentStatus.mockImplementation(() => {
      throw new Error("status unavailable");
    });

    const res = await request(app).get("/api/agent/status");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: "status unavailable",
    });
  });
});
