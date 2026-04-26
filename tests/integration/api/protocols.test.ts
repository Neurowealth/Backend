const mockDb = {
  protocolRate: { findMany: jest.fn() },
  agentLog: { findFirst: jest.fn() },
  session: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  position: { findMany: jest.fn() },
  yieldSnapshot: { findMany: jest.fn() },
  transaction: {
    count: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
  },
};

jest.mock("../../../src/db", () => ({
  __esModule: true,
  default: mockDb,
  db: mockDb,
}));

import request from "supertest";
import app from "../../../src/index";

describe("Protocols routes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/protocols/rates", () => {
    it("returns latest rates with normalized number fields", async () => {
      mockDb.protocolRate.findMany.mockResolvedValue([
        {
          protocolName: "Blend",
          assetSymbol: "USDC",
          supplyApy: "8.75",
          borrowApy: "4.10",
          tvl: "1200000",
          network: "TESTNET",
          fetchedAt: new Date("2026-04-26T12:00:00.000Z"),
        },
      ]);

      const res = await request(app).get("/api/protocols/rates");

      expect(res.status).toBe(200);
      expect(res.body.rates).toEqual([
        {
          protocolName: "Blend",
          assetSymbol: "USDC",
          supplyApy: 8.75,
          borrowApy: 4.1,
          tvl: 1200000,
          network: "TESTNET",
          fetchedAt: "2026-04-26T12:00:00.000Z",
        },
      ]);
      expect(typeof res.body.whatsappReply).toBe("string");
      expect(mockDb.protocolRate.findMany).toHaveBeenCalledWith({
        orderBy: { fetchedAt: "desc" },
        take: 10,
      });
    });
  });

  describe("GET /api/protocols/agent/status", () => {
    it("returns 404 when no status exists", async () => {
      mockDb.agentLog.findFirst.mockResolvedValue(null);

      const res = await request(app).get("/api/protocols/agent/status");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Agent status not found" });
    });

    it("returns latest persisted agent status", async () => {
      mockDb.agentLog.findFirst.mockResolvedValue({
        status: "SUCCESS",
        action: "ANALYZE",
        createdAt: new Date("2026-04-26T13:00:00.000Z"),
      });

      const res = await request(app).get("/api/protocols/agent/status");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "SUCCESS",
        action: "ANALYZE",
        updatedAt: "2026-04-26T13:00:00.000Z",
        whatsappReply: expect.any(String),
      });
      expect(mockDb.agentLog.findFirst).toHaveBeenCalledWith({
        orderBy: { createdAt: "desc" },
      });
    });
  });
});
