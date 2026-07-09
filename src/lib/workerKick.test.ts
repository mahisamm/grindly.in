import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { spawnWorkerKick } from "@/lib/workerKick";

function fakeChild() {
  return { on: vi.fn(), unref: vi.fn() };
}

let root: string;

beforeEach(() => {
  vi.resetAllMocks();
  mockSpawn.mockReturnValue(fakeChild());
  root = fs.mkdtempSync(path.join(os.tmpdir(), "workerkick-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("spawnWorkerKick", () => {
  it("creates the log dir and per-user log file, then spawns the worker", () => {
    spawnWorkerKick(root, "u1");
    const logPath = path.join(root, "data", "logs", "u1.log");
    expect(fs.existsSync(logPath)).toBe(true);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual([path.join(root, "agent", "worker.py"), "--drain"]);
  });

  it("appends across calls while under the size cap", () => {
    const logPath = path.join(root, "data", "logs", "u1.log");
    spawnWorkerKick(root, "u1");
    fs.appendFileSync(logPath, "some log output\n");
    spawnWorkerKick(root, "u1");
    expect(fs.readFileSync(logPath, "utf8")).toContain("some log output");
  });

  it("truncates the log instead of appending once it exceeds 1MB", () => {
    const logDir = path.join(root, "data", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "u1.log");
    fs.writeFileSync(logPath, Buffer.alloc(1024 * 1024 + 1, "x"));
    expect(fs.statSync(logPath).size).toBeGreaterThan(1024 * 1024);

    spawnWorkerKick(root, "u1");

    expect(fs.statSync(logPath).size).toBe(0);
  });

  it("does not throw when spawn fails (e.g. Python not installed)", () => {
    mockSpawn.mockImplementation(() => { throw new Error("spawn ENOENT"); });
    expect(() => spawnWorkerKick(root, "u1")).not.toThrow();
  });

  it("uses PYTHON_BIN when set", () => {
    const prev = process.env.PYTHON_BIN;
    process.env.PYTHON_BIN = "/custom/python";
    spawnWorkerKick(root, "u1");
    const [bin] = mockSpawn.mock.calls[0];
    expect(bin).toBe("/custom/python");
    if (prev === undefined) delete process.env.PYTHON_BIN; else process.env.PYTHON_BIN = prev;
  });
});
