import { redirect } from "next/navigation";

// Beta: Google is the only way in, so there's no separate sign-up flow — send
// everyone to the single /login entry. (The old email/phone signup form lives in
// git history if we re-enable password auth later.)
export default function SignupPage() {
  redirect("/login");
}
