import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { FollowupBulkBar } from "./FollowupBulkBar";
import { resetApiState } from "@/lib/api";

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => IST_DAY.format(new Date());
const bodyOf = (c: { body: unknown }) => JSON.parse(String(c.body));

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("FollowupBulkBar", () => {
  it("names the scope: the whole batch, or one company in it", () => {
    const { rerender } = render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={vi.fn()} />);
    expect(screen.getByText("Follow-up for all contacts in “Spring”")).toBeInTheDocument();
    rerender(<FollowupBulkBar batchId="b-1" batchName="Spring" company="Acme" onApplied={vi.fn()} />);
    expect(screen.getByText("Follow-up for all contacts at Acme in “Spring”")).toBeInTheDocument();
  });

  it("defaults the date to a week out (IST) and bounds it to today..today+90", () => {
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={vi.fn()} />);
    const date = screen.getByLabelText("Follow-up date") as HTMLInputElement;
    expect(date.type).toBe("date");
    expect(date.value).toBe(plusDays(today(), 7));
    expect(date.min).toBe(today());
    expect(date.max).toBe(plusDays(today(), 90));
  });

  it("schedules the follow-up for the batch and company on the picked date, then reports the counts", async () => {
    const seen = stubFetch(() => json({ updated: 3, skipped: 2, total: 5 }));
    const onApplied = vi.fn();
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" company="Acme" onApplied={onApplied} />);
    const day = plusDays(today(), 10);
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: day } });
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(await screen.findByText("Updated 3 of 5 · 2 skipped (replied, bounced or opted out)")).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/api/followups/bulk", method: "PUT" });
    expect(bodyOf(seen[0]!)).toEqual({ batchId: "b-1", company: "Acme", enabled: true, date: day });
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("leaves out the skipped part when nothing was skipped", async () => {
    stubFetch(() => json({ updated: 4, skipped: 0, total: 4 }));
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(await screen.findByText("Updated 4 of 4")).toBeInTheDocument();
  });

  it("asks before turning follow-ups off, then sends enabled:false without a date", async () => {
    const seen = stubFetch(() => json({ updated: 5, skipped: 0, total: 5 }));
    const onApplied = vi.fn();
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={onApplied} />);
    await userEvent.click(screen.getByRole("button", { name: "Turn off follow-ups" }));
    const dlg = await screen.findByRole("alertdialog");
    expect(within(dlg).getByText(/Turn off follow-ups for all contacts in “Spring”\?/)).toBeInTheDocument();
    expect(seen).toHaveLength(0);
    await userEvent.click(within(dlg).getByRole("button", { name: "Turn off" }));
    await vi.waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(bodyOf(seen[0]!)).toEqual({ batchId: "b-1", enabled: false });
    expect(await screen.findByText("Updated 5 of 5")).toBeInTheDocument();
  });

  it("shows the server's error and does not report success", async () => {
    stubFetch(() => json({ error: "date must be today or later" }, 400));
    const onApplied = vi.fn();
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={onApplied} />);
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(await screen.findByText("date must be today or later")).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("refuses a date outside the next 90 days without calling the server", async () => {
    const seen = stubFetch(() => json({ updated: 0, skipped: 0, total: 0 }));
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Follow-up date"), { target: { value: plusDays(today(), 91) } });
    await userEvent.click(screen.getByRole("button", { name: "Schedule follow-up" }));
    expect(screen.getByText("Pick a date within the next 90 days")).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it("disables both actions while a request is in flight", async () => {
    let release!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((r) => (release = r)));
    render(<FollowupBulkBar batchId="b-1" batchName="Spring" onApplied={vi.fn()} />);
    const schedule = screen.getByRole("button", { name: "Schedule follow-up" });
    await userEvent.click(schedule);
    expect(schedule).toBeDisabled();
    expect(screen.getByRole("button", { name: "Turn off follow-ups" })).toBeDisabled();
    release(json({ updated: 1, skipped: 0, total: 1 }));
    await vi.waitFor(() => expect(schedule).toBeEnabled());
  });
});
