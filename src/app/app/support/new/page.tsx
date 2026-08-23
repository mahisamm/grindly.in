import { currentUser } from "@/lib/auth";
import { TicketThread } from "@/components/TicketThread";

export const dynamic = "force-dynamic";
export const metadata = { title: "New conversation — Grindly" };

/** An empty chat. The first message starts the conversation and the page
    moves to its permanent address. */
export default async function NewConversationPage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected
  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-6 sm:py-10">
      <TicketThread initial={null} viewer="user" backHref="/app/support" backLabel="All conversations" />
    </div>
  );
}
