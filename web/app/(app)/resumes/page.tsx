import type { Metadata } from "next";
import { ResumesPanel } from "@/components/ResumesPanel";
import { PageBody, PageHeader } from "@/components/PageHeader";

export const metadata: Metadata = { title: "Resumes" };

export default function ResumesPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Create / Resumes"
        title="Resume library"
        description="PDFs you can attach. The default goes with every first email unless a batch or contact picks another."
      />
      <PageBody max="max-w-[1200px]">
        <ResumesPanel />
      </PageBody>
    </div>
  );
}
