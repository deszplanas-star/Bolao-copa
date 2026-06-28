import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Mata-mata é a entrada do app (fase atual). A fase de grupos fica em /apostas.
  if (user) redirect("/copa");
  redirect("/home.html");
}
