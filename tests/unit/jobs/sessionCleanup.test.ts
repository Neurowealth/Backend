const mockDeleteMany = jest.fn();
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
};

jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn(() => ({
    session: {
      deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
    },
  })),
}));

jest.mock("../../../src/utils/logger", () => ({
  logger: mockLogger,
}));

import { config } from "../../../src/config/env";
import {
  cleanupExpiredSessions,
  scheduleSessionCleanup,
} from "../../../src/jobs/sessionCleanup";

describe("sessionCleanup job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("deletes expired sessions and logs when rows were removed", async () => {
    mockDeleteMany.mockResolvedValue({ count: 2 });

    await cleanupExpiredSessions();

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[SessionCleanup] Removed 2 expired session(s)",
    );
  });

  it("does not log removal message when nothing was deleted", async () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });

    await cleanupExpiredSessions();

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Removed"),
    );
  });

  it("logs an error when deleteMany fails", async () => {
    const error = new Error("db unavailable");
    mockDeleteMany.mockRejectedValue(error);

    await cleanupExpiredSessions();

    expect(mockLogger.error).toHaveBeenCalledWith(
      "[SessionCleanup] Failed to clean up sessions:",
      error,
    );
  });

  it("runs immediately and schedules recurring cleanup with configured interval", () => {
    mockDeleteMany.mockResolvedValue({ count: 0 });

    const setIntervalSpy = jest.spyOn(global, "setInterval");

    const handle = scheduleSessionCleanup();

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      config.jwt.interval_ms,
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      "[SessionCleanup] Daily cleanup scheduled",
    );

    clearInterval(handle);
    setIntervalSpy.mockRestore();
  });
});
