import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { readStruct } from "@/lib/resumeStruct";
import { Editor } from "./Editor";
import { LinkStyleChoice } from "./LinkStyle";
import { ExtractPrompt } from "./ExtractPrompt";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit your resume — Grindly" };

/**
 * The editor.
 *
 * Renders the saved fields if there are any, and otherwise offers to read them
 * out of the resume — which costs model calls, so it is a button rather than
 * something that happens because someone opened a page. The extraction is the
 * same code every rewrite already runs; the only new thing is that its result
 * is now something a person can change.
 */
export default async function EditPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    select: {
      id: true, label: true, structJson: true, score: true, chars: true,
      linkStyle: true,
    },
  });
  if (!resume) notFound();

  const struct = readStruct(resume.structJson);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
      <Link
        href={`/app/${resume.id}`}
        className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm"
      >
        ← Back to the report
      </Link>

      <div className="mt-4">
        {struct ? (
          <>
            <Editor
              resumeId={resume.id}
              resumeLabel={resume.label}
              initial={struct}
              baselineScore={resume.score}
            />
            <div className="mt-8 max-w-md">
              <LinkStyleChoice resumeId={resume.id} value={resume.linkStyle} />
            </div>
          </>
        ) : (
          <ExtractPrompt resumeId={resume.id} readable={resume.chars >= 200} />
        )}
      </div>
    </div>
  );
}
