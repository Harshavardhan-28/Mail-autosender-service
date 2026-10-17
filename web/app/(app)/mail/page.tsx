import type { Metadata } from "next";
import { MailListView } from "@/components/MailListView";

export const metadata: Metadata = { title: "Mail" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function MailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const page = Number(one(sp.page));
  return <MailListView initialTab={one(sp.tab)} initialQ={one(sp.q)} initialKind={one(sp.kind)} initialCompany={one(sp.company)} initialPage={Number.isInteger(page) && page > 0 ? page : 1} />;
}
