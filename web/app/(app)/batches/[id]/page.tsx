import type { Metadata } from "next";
import { BatchView } from "@/components/BatchView";

export const metadata: Metadata = { title: "Batch" };

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BatchView id={id} />;
}
