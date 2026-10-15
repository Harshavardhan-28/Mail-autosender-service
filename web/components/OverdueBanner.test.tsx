import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { json, stubFetch } from "@/test/fetch";
import { resetApiState } from "@/lib/api";
import { OverdueBanner } from "./OverdueBanner";

const WINDOW = { enforced: true, window: { start: "09:00", end: "10:00", tz: "Asia/Kolkata" } };
const now = () => new Date("2030-01-10T00:00:00Z"); // 05:30 IST, before the window opens
const overdue = (count: number) => ({ count, overdueMinutes: 60, messages: [] });

beforeEach(() => resetApiState());
afterEach(() => vi.unstubAllGlobals());

describe("OverdueBanner", () => {
  it("renders nothing when nothing is overdue", async () => {
    const seen = stubFetch((c) => (c.url === "/api/messages/overdue" ? json(overdue(0)) : json(WINDOW)));
    const { container } = render(<OverdueBanner now={now} />);
    await vi.waitFor(() => expect(seen.some((c) => c.url === "/api/messages/overdue")).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it("fails quietly when the request fails", async () => {
    const seen = stubFetch(() => json({ error: "boom" }, 500));
    const { container } = render(<OverdueBanner now={now} />);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(container).toBeEmptyDOMElement();
  });

  it("warns, previews the window plan live, reschedules and then disappears", async () => {
    let remaining = 3;
    const seen = stubFetch((c) => {
      if (c.url === "/api/messages/overdue") return json(overdue(remaining));
      if (c.url === "/api/settings/send-window") return json(WINDOW);
      if (c.url === "/api/messages/reschedule-overdue") {
        remaining = 0;
        return json({ rescheduled: 3, messages: [], plan: null });
      }
      return json({});
    });
    const onRescheduled = vi.fn();
    render(<OverdueBanner now={now} onRescheduled={onRescheduled} />);
    expect(await screen.findByText(/3 scheduled emails are past due \(their send window closed before they went out\)\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reschedule to next window" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/3 emails in 3 slots, 1 per slot, 09:00-09:10 Asia\/Kolkata/)).toBeInTheDocument();
    const input = within(dialog).getByLabelText(/Stagger/);
    expect(input).toHaveValue(5);
    await userEvent.clear(input);
    await userEvent.type(input, "30");
    expect(within(dialog).getByText(/3 emails in 2 slots, 2 per slot, 09:00-09:30 Asia\/Kolkata/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Reschedule 3 emails" }));
    await vi.waitFor(() => expect(onRescheduled).toHaveBeenCalled());
    const post = seen.find((c) => c.url === "/api/messages/reschedule-overdue")!;
    expect(JSON.parse(String(post.body))).toEqual({ staggerMinutes: 30 });
    await vi.waitFor(() => expect(screen.queryByText(/past due/)).toBeNull());
  });

  it("singular wording for one email", async () => {
    stubFetch((c) => (c.url === "/api/messages/overdue" ? json(overdue(1)) : json(WINDOW)));
    render(<OverdueBanner now={now} />);
    expect(await screen.findByText(/1 scheduled email is past due/)).toBeInTheDocument();
  });
});
