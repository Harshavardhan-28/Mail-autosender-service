import type { Metadata } from "next";
import { ResumesPanel } from "@/components/ResumesPanel";
import { PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = { title: "Resumes" };

export default function ResumesPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        eyebrow="Create / Resumes"
        title="Resume library"
        description="PDFs you can attach. The default goes with every first email unless a batch or contact picks another."
      />
      <ResumesPanel />
    </div>
  );
}
