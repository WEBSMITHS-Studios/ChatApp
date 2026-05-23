import { useRouter } from "next/router";
import { ChatPage } from "@/components/ChatPage";

export default function RoomPage() {
  const router = useRouter();
  const slug = typeof router.query.slug === "string" ? router.query.slug : "";

  return <ChatPage slug={slug} />;
}
