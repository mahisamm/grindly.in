import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid,
  mockMkdir,
  mockWriteFile,
  mockAccess,
  mockProfileUpsert,
  mockAgentRunCreate,
  mockSpawnWorkerKick,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockAccess: vi.fn(),
  mockProfileUpsert: vi.fn(),
  mockAgentRunCreate: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    profile: { upsert: mockProfileUpsert },
    agentRun: { create: mockAgentRunCreate },
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));
vi.mock("node:fs/promises", () => ({
  default: { mkdir: mockMkdir, writeFile: mockWriteFile, access: mockAccess },
}));

import { POST } from "@/app/api/resume/route";

function makeReq(file: File | null) {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("http://localhost/api/resume", { method: "POST", body: form });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockAccess.mockRejectedValue(new Error("no python here")); // default: no worker.py kick
  mockProfileUpsert.mockResolvedValue({ id: "p1" });
  mockAgentRunCreate.mockResolvedValue({ id: "r1" });
});

describe("POST /api/resume", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file field present", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq(null));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an unsupported file extension", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq(new File(["hi"], "resume.exe", { type: "application/octet-stream" })));
    expect(res.status).toBe(400);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns 413 for a file over the 5MB cap", async () => {
    mockGetUid.mockResolvedValue("u1");
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    const res = await POST(makeReq(new File([big], "resume.pdf", { type: "application/pdf" })));
    expect(res.status).toBe(413);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("returns 500 with a clean message (no raw stack) when disk write fails", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockWriteFile.mockRejectedValue(new Error("EACCES: permission denied"));
    const res = await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).not.toMatch(/EACCES/);
  });

  it("returns 500 when the DB write fails, after the file is already saved", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockProfileUpsert.mockRejectedValue(new Error("db down"));
    const res = await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));
    expect(res.status).toBe(500);
    expect(mockWriteFile).toHaveBeenCalled(); // file was written before the DB step
  });

  it("accepts a valid PDF, saves it, and queues an analyze run", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockAgentRunCreate).toHaveBeenCalledWith({ data: { userId: "u1", mode: "analyze" } });
  });

  it("extracts resume text immediately for a .txt upload", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq(new File(["Skills: React, Node"], "resume.txt", { type: "text/plain" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.parsed).toBe(true);
  });

  it("kicks the local worker only when worker.py is present", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAccess.mockResolvedValue(undefined); // worker.py exists on this box
    await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));
    expect(mockSpawnWorkerKick).toHaveBeenCalledWith(process.cwd(), "u1");
  });

  it("does not kick the worker when worker.py is missing (slim prod image)", async () => {
    mockGetUid.mockResolvedValue("u1");
    await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));
    expect(mockSpawnWorkerKick).not.toHaveBeenCalled();
  });
});
