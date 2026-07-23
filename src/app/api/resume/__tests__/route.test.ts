import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid,
  mockUserFindUnique,
  mockMkdir,
  mockWriteFile,
  mockAccess,
  mockRm,
  mockProfileUpsert,
  mockAgentRunCreate,
  mockVariantDeleteMany,
  mockSpawnWorkerKick,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockAccess: vi.fn(),
  mockRm: vi.fn(),
  mockProfileUpsert: vi.fn(),
  mockAgentRunCreate: vi.fn(),
  mockVariantDeleteMany: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // requireAccess() (the route's access gate) loads the user before doing work.
    user: { findUnique: mockUserFindUnique },
    profile: { upsert: mockProfileUpsert },
    agentRun: { create: mockAgentRunCreate },
    resumeVariant: { deleteMany: mockVariantDeleteMany },
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: mockMkdir,
    writeFile: mockWriteFile,
    access: mockAccess,
    rm: mockRm,
  },
}));

import { POST } from "@/app/api/resume/route";

function makeReq(file: File | null) {
  const form = new FormData();
  if (file) form.set("file", file);
  return new Request("http://localhost/api/resume", { method: "POST", body: form });
}

beforeEach(() => {
  vi.resetAllMocks();
  // Approved by default so requireAccess() lets the upload through; the 401 test
  // sets getUid null and never reaches this lookup.
  mockUserFindUnique.mockResolvedValue({ id: "u1", accessStatus: "approved", role: "user", email: "u1@example.com" });
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockAccess.mockRejectedValue(new Error("no python here")); // default: no worker.py kick
  mockProfileUpsert.mockResolvedValue({ id: "p1" });
  mockAgentRunCreate.mockResolvedValue({ id: "r1" });
  mockVariantDeleteMany.mockResolvedValue({ count: 0 });
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

  // A new master resume must invalidate everything derived from the old one.
  // Without this, the stale skills stay on the profile and worker.run_for_user
  // only re-extracts when the list is EMPTY — so uploading an updated resume
  // changed precisely nothing, silently, forever.
  it("clears the skills and score derived from the previous resume", async () => {
    mockGetUid.mockResolvedValue("u1");
    await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));

    const arg = mockProfileUpsert.mock.calls[0][0];
    expect(arg.update).toMatchObject({
      skills: "[]",
      resumeScore: null,
      resumeSuggestions: null,
      resumeParseFailed: false,
    });
  });

  it("removes the previous resume file when the new one has a different extension", async () => {
    mockGetUid.mockResolvedValue("u1");
    await POST(makeReq(new File(["hi"], "resume.pdf", { type: "application/pdf" })));

    const removed = mockRm.mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.endsWith("u1.docx"))).toBe(true);
    expect(removed.some((p) => p.endsWith("u1.txt"))).toBe(true);
    // ...but never the file we just wrote
    expect(removed.some((p) => p.endsWith("u1.pdf"))).toBe(false);
  });

  describe("LaTeX source (.tex)", () => {
    it("saves it under resume_tex, NOT beside the master resume", async () => {
      mockGetUid.mockResolvedValue("u1");
      const res = await POST(makeReq(new File(["\\section{Skills}"], "resume.tex")));
      expect(res.status).toBe(200);

      // agent/resume_parse.py:find_resume_file() scans data/resumes for "<uid>." and
      // feeds the first hit to the PDF text extractor — a .tex in there would be
      // picked as the resume itself and parsed as garbage.
      const written = String(mockWriteFile.mock.calls[0][0]);
      expect(written).toContain("resume_tex");
      expect(written).toMatch(/u1\.tex$/);
    });

    it("does not re-run resume analysis — a .tex changes no extracted skill", async () => {
      mockGetUid.mockResolvedValue("u1");
      await POST(makeReq(new File(["\\section{Skills}"], "resume.tex")));

      const modes = mockAgentRunCreate.mock.calls.map((c) => c[0].data.mode);
      expect(modes).not.toContain("analyze");
    });

    // A .tex that won't compile, or whose headings we don't recognise, would
    // otherwise fail silently and FOREVER: the agent falls back to the master
    // resume on every application and never says why. So prove it at upload.
    it("queues a compile self-test and marks the file as unverified until it passes", async () => {
      mockGetUid.mockResolvedValue("u1");
      await POST(makeReq(new File(["\\section{Skills}"], "resume.tex")));

      expect(mockProfileUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            resumeTexName: "resume.tex",
            resumeTexStatus: "checking",
          }),
        }),
      );
      expect(mockAgentRunCreate).toHaveBeenCalledWith({
        data: { userId: "u1", mode: "latex_check" },
      });
    });

    it("rejects a .tex over its own (much smaller) size cap", async () => {
      mockGetUid.mockResolvedValue("u1");
      const big = new Uint8Array(512 * 1024 + 1);
      const res = await POST(makeReq(new File([big], "resume.tex")));
      expect(res.status).toBe(413);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });
});
