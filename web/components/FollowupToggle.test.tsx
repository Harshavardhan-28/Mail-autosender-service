import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { FollowupToggle } from "./FollowupToggle";
import { resetApiState } from "@/lib/api";

const contact = { id: "c-1", email: "jo@acme.com", followupRequested: false, followupDelayDays: 7, followupAt: null as string | null };

const IST_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const plusDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = () => IST_DAY.format(new Date());

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("FollowupToggle", () => {
  it("defaults the date to a week out (IST) and bounds it to today..today+90", () => {
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    const date = screen.getByLabelText(/follow-up date/i) as HTMLInputElement;
    expect(date.type).toBe("date");
    expect(date.value).toBe(plusDays(today(), 7));
    expect(date.min).toBe(today());
    expect(date.max).toBe(plusDays(today(), 90));
  });

  it("shows a scheduled followupAt as its IST calendar date", () => {
    // 2030-03-05 09:00 IST == 03:30Z
    render(<FollowupToggle contact={{ ...contact, followupRequested: true, followupAt: "2030-03-05T03:30:00.000Z" }} />);
    expect((screen.getByLabelText(/follow-up date/i) as HTMLInputElement).value).toBe("2030-03-05");
  });

  it("ticking calls PUT /api/contacts/:id/followup with the date", async () => {
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: true }, followup: null }));
    const onChange = vi.fn();
    render(<FollowupToggle contact={contact} onChange={onChange} />);
    await userEvent.click(screen.getByRole("switch", { name: /follow up with jo@acme.com/i }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "/api/contacts/c-1/followup", method: "PUT" });
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, date: plusDays(today(), 7) });
    expect(seen[0]!.headers.get("X-CSRF-Token")).toBe("t");
  });

  it("ticks immediately while the save is in flight", async () => {
    let release!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((r) => (release = r)));
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    const box = screen.getByRole("switch");
    await userEvent.click(box);
    expect(box).toBeChecked();
    release(json({ contact: { ...contact, followupRequested: true }, followup: null }));
    await vi.waitFor(() => expect(box).toBeEnabled());
    expect(box).toBeChecked();
  });

  it("unticking sends enabled:false with no date", async () => {
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: false }, followup: null }));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("switch"));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: false });
  });

  it("changing the date of an enabled follow-up saves the new date", async () => {
    const picked = plusDays(today(), 3);
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: true, followupAt: "2030-01-01T03:30:00.000Z" }, followup: null }));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/follow-up date/i), { target: { value: picked } });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, date: picked });
  });

  it("changing the date while unticked does not call the server", async () => {
    const seen = stubFetch(() => json({}));
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/follow-up date/i), { target: { value: plusDays(today(), 3) } });
    expect(seen).toHaveLength(0);
  });

  it("rejects an out-of-range date without calling the server", async () => {
    const seen = stubFetch(() => json({}));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/follow-up date/i), { target: { value: plusDays(today(), 120) } });
    expect(await screen.findByText(/within the next 90 days/i)).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it("surfaces the server's 400 message", async () => {
    stubFetch(() => json({ error: "Follow-up date is in the past" }, 400));
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText(/in the past/i)).toBeInTheDocument();
    expect(screen.getByRole("switch")).not.toBeChecked();
  });

  it("shows why the server refused and leaves the box unticked", async () => {
    stubFetch(() => json({ error: "Some contacts cannot be scheduled", refused: [{ contactId: "c-1", email: "jo@acme.com", reason: "opted_out" }] }, 409));
    render(<FollowupToggle contact={contact} onChange={vi.fn()} />);
    const box = screen.getByRole("switch");
    await userEvent.click(box);
    expect(await screen.findByText(/opted out/i)).toBeInTheDocument();
    expect(box).not.toBeChecked();
  });
});
