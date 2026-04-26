import request from "supertest";
import app from "../../../src/index";

describe("Health route", () => {
  it("returns 200 with health payload", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: "1.0.0",
      environment: expect.any(String),
      timestamp: expect.any(String),
    });

    expect(new Date(res.body.timestamp).toString()).not.toBe("Invalid Date");
  });
});
