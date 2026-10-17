import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { FollowupToggle } from "./FollowupToggle";
import { resetApiState } from "@/lib/api";
import { formatCalendarDay } from "@/lib/format";

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

  it("changing the date of an enabled follow-up saves the new date when the field is left", async () => {
    const picked = plusDays(today(), 3);
    const seen = stubFetch(() => json({ contact: { ...contact, followupRequested: true, followupAt: "2030-01-01T03:30:00.000Z" }, followup: null }));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true }} onChange={vi.fn()} />);
    const input = screen.getByLabelText(/follow-up date/i);
    fireEvent.change(input, { target: { value: picked } });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, date: picked });
  });

  it("does not save on every keystroke: intermediate values are kept until blur or Enter, and the field stays editable while saving", async () => {
    let release!: (r: Response) => void;
    const seen = stubFetch(() => new Promise<Response>((r) => (release = r)));
    const saved = "2030-01-01T03:30:00.000Z";
    render(<FollowupToggle contact={{ ...contact, followupRequested: true, followupAt: saved }} onChange={vi.fn()} />);
    const input = screen.getByLabelText(/follow-up date/i) as HTMLInputElement;
    const a = plusDays(today(), 2);
    const b = plusDays(today(), 24);
    fireEvent.change(input, { target: { value: a } });
    fireEvent.change(input, { target: { value: b } });
    expect(seen).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, date: b });
    expect(input).toBeEnabled();
    release(json({ contact: { ...contact, followupRequested: true, followupAt: new Date(`${b}T03:30:00Z`).toISOString() }, followup: null }));
    await vi.waitFor(() => expect(screen.getByRole("switch")).toBeEnabled());
    expect(input.value).toBe(b);
  });

  it("ignores a stale response that arrives after a newer save", async () => {
    const releases: ((r: Response) => void)[] = [];
    stubFetch(() => new Promise<Response>((r) => releases.push(r)));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true, followupAt: "2030-01-01T03:30:00.000Z" }} onChange={vi.fn()} />);
    const input = screen.getByLabelText(/follow-up date/i) as HTMLInputElement;
    const a = plusDays(today(), 2);
    const b = plusDays(today(), 4);
    fireEvent.change(input, { target: { value: a } });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    fireEvent.change(input, { target: { value: b } });
    fireEvent.blur(input);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(json({ contact: { ...contact, followupRequested: true, followupAt: new Date(`${b}T03:30:00Z`).toISOString() }, followup: null }));
    await vi.waitFor(() => expect(input.value).toBe(b));
    releases[0]!(json({ contact: { ...contact, followupRequested: true, followupAt: new Date(`${a}T03:30:00Z`).toISOString() }, followup: null }));
    await new Promise((r) => setTimeout(r, 20));
    expect(input.value).toBe(b);
  });

  it("a refused date change puts the last saved date back in the field", async () => {
    const saved = "2030-01-01T03:30:00.000Z";
    stubFetch(() => json({ error: "Some contacts cannot be scheduled", refused: [{ contactId: "c-1", email: "jo@acme.com", reason: "bounced" }] }, 409));
    render(<FollowupToggle contact={{ ...contact, followupRequested: true, followupAt: saved }} onChange={vi.fn()} />);
    const input = screen.getByLabelText(/follow-up date/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: plusDays(today(), 3) } });
    fireEvent.blur(input);
    expect(await screen.findByText(/bounced/i)).toBeInTheDocument();
    expect(input.value).toBe("2030-01-01");
    expect(screen.getByRole("switch")).toBeChecked();
  });

  describe("legacy follow-up (requested, no picked date)", () => {
    const legacy = { ...contact, followupRequested: true, followupDelayDays: 5, followupAt: null };

    it("says it goes N days after the first email instead of inventing a date, and leaves the date empty", () => {
      render(<FollowupToggle contact={legacy} />);
      expect(screen.getByText("5 days after the first email")).toBeInTheDocument();
      expect(screen.queryByText(/^Sends/)).not.toBeInTheDocument();
      expect((screen.getByLabelText(/follow-up date/i) as HTMLInputElement).value).toBe("");
    });

    it("shows the live follow-up's scheduled day when there is one", () => {
      render(<FollowupToggle contact={{ ...legacy, messages: [{ id: "f-1", kind: "followup", state: "scheduled", scheduledFor: "2030-03-05T03:30:00.000Z", sentAt: null }] }} />);
      expect(screen.getByText(`Sends ${formatCalendarDay("2030-03-05")}`)).toBeInTheDocument();
    });

    it("can pick the default (a week out) date and save it", async () => {
      const day = plusDays(today(), 7);
      const seen = stubFetch(() => json({ contact: { ...legacy, followupAt: new Date(`${day}T03:30:00Z`).toISOString() }, followup: null }));
      render(<FollowupToggle contact={legacy} onChange={vi.fn()} />);
      const input = screen.getByLabelText(/follow-up date/i);
      fireEvent.change(input, { target: { value: day } });
      fireEvent.blur(input);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(JSON.parse(String(seen[0]!.body))).toEqual({ enabled: true, date: day });
    });
  });

  it("uses the send window's time zone for today and the bounds", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T20:00:00Z")); // 18 Oct in IST, still 17 Oct in Los Angeles
    try {
      render(<FollowupToggle contact={contact} tz="America/Los_Angeles" />);
      const date = screen.getByLabelText(/follow-up date/i) as HTMLInputElement;
      expect(date.min).toBe("2026-10-17");
      expect(date.value).toBe("2026-10-24");
    } finally {
      vi.useRealTimers();
    }
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
