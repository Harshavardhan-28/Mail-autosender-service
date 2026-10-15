import type { Metadata } from "next";
import { MailDetailView } from "@/components/MailDetailView";

export const metadata: Metadata = { title: "Mail" };

export default async function MailDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const { from } = await searchParams;
  return <MailDetailView id={id} backQuery={typeof from === "string" ? from : ""} />;
}
