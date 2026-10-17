import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { AttachmentNameForm } from "./AttachmentNameForm";
import { resetApiState } from "@/lib/api";

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

const info = (name: string, isDefault = false, source: "saved" | "sender_name" | "fallback" = isDefault ? "sender_name" : "saved") => ({ name, fileName: `${name}.pdf`, isDefault, source });

describe("AttachmentNameForm", () => {
  it("shows the current name and what attachments are sent as", async () => {
    stubFetch(() => json(info("Harshavardhan_Khamkar_Resume", true)));
    render(<AttachmentNameForm />);
    expect(await screen.findByDisplayValue("Harshavardhan_Khamkar_Resume")).toBeInTheDocument();
    expect(screen.getByText(/Harshavardhan_Khamkar_Resume\.pdf/)).toBeInTheDocument();
  });

  it("says the default comes from the sender name only when there is one", async () => {
    stubFetch(() => json(info("Harshavardhan_Khamkar_Resume", true, "sender_name")));
    const { unmount } = render(<AttachmentNameForm />);
    expect(await screen.findByText(/from your sender name/)).toBeInTheDocument();
    unmount();
    vi.unstubAllGlobals();
    resetApiState();
    stubFetch(() => json(info("Resume", true, "fallback")));
    render(<AttachmentNameForm />);
    expect(await screen.findByText(/no sender name is set/i)).toBeInTheDocument();
    expect(screen.queryByText(/from your sender name/)).toBeNull();
  });

  it("accepts names in Indian scripts and with accents", async () => {
    const seen = stubFetch((c) => (c.method === "PUT" ? json(info("हर्ष_Résumé")) : json(info("Resume", true, "fallback"))));
    render(<AttachmentNameForm />);
    const input = await screen.findByLabelText("File name in emails");
    await userEvent.clear(input);
    await userEvent.type(input, "हर्ष_Résumé");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. Resumes are sent as हर्ष_Résumé.pdf.")).toBeInTheDocument();
    expect(seen.some((c) => c.method === "PUT")).toBe(true);
  });

  it("saves a new name with PUT and shows the saved file name", async () => {
    const seen = stubFetch((c) => (c.method === "PUT" ? json(info("HK_CV")) : json(info("Harshavardhan_Khamkar_Resume", true))));
    render(<AttachmentNameForm />);
    const input = await screen.findByLabelText("File name in emails");
    await userEvent.clear(input);
    await userEvent.type(input, "HK_CV");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved. Resumes are sent as HK_CV.pdf.")).toBeInTheDocument();
    const put = seen.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/api/settings/attachment-name");
    expect(JSON.parse(String(put.body))).toEqual({ name: "HK_CV" });
    expect(screen.getAllByText(/HK_CV\.pdf/)).toHaveLength(2); // the description line updates too
  });

  it("blocks characters that can't go in a file name before calling the server", async () => {
    const seen = stubFetch(() => json(info("Resume", true)));
    render(<AttachmentNameForm />);
    const input = await screen.findByLabelText("File name in emails");
    await userEvent.clear(input);
    await userEvent.type(input, "a/b");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/letters, digits, spaces/i)).toBeInTheDocument();
    expect(seen.some((c) => c.method === "PUT")).toBe(false);
  });

  it("shows the server's error text", async () => {
    stubFetch((c) => (c.method === "PUT" ? json({ error: "Invalid file name: At most 100 characters" }, 400) : json(info("Resume", true))));
    render(<AttachmentNameForm />);
    const input = await screen.findByLabelText("File name in emails");
    await userEvent.clear(input);
    await userEvent.type(input, "ok");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/At most 100 characters/)).toBeInTheDocument();
  });

  it("can go back to the default name", async () => {
    const seen = stubFetch((c) => (c.method === "PUT" ? json(info("Harshavardhan_Khamkar_Resume", true)) : json(info("HK_CV"))));
    render(<AttachmentNameForm />);
    await userEvent.click(await screen.findByRole("button", { name: "Use default" }));
    expect(await screen.findByDisplayValue("Harshavardhan_Khamkar_Resume")).toBeInTheDocument();
    expect(JSON.parse(String(seen.find((c) => c.method === "PUT")!.body))).toEqual({ reset: true });
  });
});
